import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees, outputDifferenceReport } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_FILE } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Hero.js": `import { createElement } from "react";
import "./Hero.css";
export default function Hero({ title }) {
  return createElement(
    "section",
    { className: "fw-hero" },
    "marker-hero-8c40 " + title,
  );
}
`,
  "Hero.css": `.fw-hero { color: rgb(31, 32, 33); }\n`,
  "Badge.js": `import { createElement } from "react";
import "./Badge.css";
export default function Badge({ tone }) {
  return createElement(
    "span",
    { className: "fw-badge badge-" + tone },
    "marker-badge-8c40",
  );
}
`,
  "Badge.css": `.fw-badge { color: rgb(41, 42, 43); }\n`,
  "global.css": `.fw-global { color: rgb(51, 52, 53); }\n`,
};

const FAKE_COMPILER =
  'driftSupplement: (classes) => classes.map((name) => "." + name + "{--fw-supplement:1}").join(""),';

const roots: string[] = [];

// A directory per call: Node caches a config module by URL, so a second site at one
// path would be built from the first one's config.
function site(name: string, extra: string): string {
  const root = join(SITES, `.pagedeck-drift-verb-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, data] of [
    ["home", { title: "Home" }],
    ["pricing", { title: "Pricing", tone: "calm" }],
  ] as const) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    css: ["./components/global.css"],
    ${extra}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
      Badge: { path: "./components/Badge.js", hydrate: "visible" },
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: (page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      return {
        tree:
          page.path === "/pricing"
            ? [
                { component: "Hero", props: { title: entry.data.title } },
                { component: "Badge", props: { tone: entry.data.tone } },
              ]
            : [{ component: "Hero", props: { title: entry.data.title } }],
      };
    },
  },
});
`,
  );
  return root;
}

function editPricing(root: string, data: Record<string, string>): void {
  writeFileSync(
    join(root, "content", "en", "pricing.json"),
    `${JSON.stringify({ rev: 2, data })}\n`,
  );
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(cwd: string, ...argv: string[]): Promise<Run> {
  const { runCli } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function ok(cwd: string, ...argv: string[]): Promise<Run> {
  const result = await run(cwd, ...argv);
  if (result.code !== EXIT_CODES.success) throw new Error(result.err);
  return result;
}

function manifestOf(dist: string): Manifest {
  return JSON.parse(
    readFileSync(join(dist, MANIFEST_FILE), "utf8"),
  ) as Manifest;
}

function stylesheets(dist: string): Map<string, string> {
  const sheets = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".css")) {
        sheets.set(relative(dist, path), readFileSync(path, "utf8"));
      }
    }
  };
  walk(dist);
  return sheets;
}

interface Drifted {
  before: string;
  second: string;
  err: string;
}

async function drifted(name: string, extra: string): Promise<Drifted> {
  const root = site(name, extra);
  const dist = join(root, "dist");
  await ok(root, "sync");
  await ok(root, "build");
  const before = join(root, "dist-before");
  cpSync(dist, before, { recursive: true });

  editPricing(root, { title: "Pricing", tone: "rogue" });
  await ok(root, "sync");
  const second = await ok(root, "build", "--incremental");
  return { before, second: dist, err: second.err };
}

let rogue: Promise<Drifted>;
function rogueSite(): Promise<Drifted> {
  rogue ??= drifted("rogue", FAKE_COMPILER);
  return rogue;
}

test("a rogue class in a re-rendered page inlines a supplement on that page alone", async () => {
  const { before, second } = await rogueSite();

  expect(manifestOf(before).classes).toContain("badge-calm");
  expect(manifestOf(before).classes).not.toContain("badge-rogue");

  const pricing = readFileSync(join(second, "pricing", "index.html"), "utf8");
  expect(pricing).toContain("badge-rogue");
  expect(pricing).toContain("<style>.badge-rogue{--fw-supplement:1}</style>");

  expect(readFileSync(join(second, "index.html"), "utf8")).not.toMatch(
    /<style[\s>]/,
  );
}, 360_000);

test("a drifted build's stylesheets are the undrifted build's, byte for byte", async () => {
  const { before, second } = await rogueSite();

  const sheets = stylesheets(second);
  expect(sheets.size).toBeGreaterThan(1);
  expect(sheets).toEqual(stylesheets(before));
  for (const css of sheets.values())
    expect(css).not.toContain("--fw-supplement");
}, 360_000);

test("a drifted build within the threshold records no full rebuild request", async () => {
  const { second } = await rogueSite();

  expect(manifestOf(second).fullRebuild).toBeUndefined();
}, 360_000);

test("a drifted build past the threshold records the manifest's full rebuild request", async () => {
  const { second } = await drifted(
    "threshold",
    `driftThreshold: 0,\n    ${FAKE_COMPILER}`,
  );

  expect(manifestOf(second).fullRebuild).toEqual({
    reason: "class-drift",
    drifted: 1,
    threshold: 0,
  });
}, 360_000);

test("both drift warning kinds reach stderr through the verb", async () => {
  const { second, err } = await drifted("no-compiler", "");

  expect(err).toContain(
    "Class drift: 1 re-rendered page uses classes the last full build's class manifest does not hold",
  );
  expect(err).toContain('"badge-rogue"');
  expect(err).toContain(
    "Class drift: 1 drifted page has no supplement, because this site declares no supplement compiler",
  );
  expect(
    readFileSync(join(second, "pricing", "index.html"), "utf8"),
  ).not.toMatch(/<style[\s>]/);
}, 360_000);

// The full rebuild in the middle runs into an emptied `dist`: a stale file left behind
// would make the two trees agree for an unrelated reason.
let clean: Promise<{ full: string; second: string; err: string }>;

function cleanEdit(): Promise<{ full: string; second: string; err: string }> {
  clean ??= (async () => {
    const root = site("clean", FAKE_COMPILER);
    const dist = join(root, "dist");
    await ok(root, "sync");
    await ok(root, "build");
    const before = join(root, "dist-before");
    cpSync(dist, before, { recursive: true });

    editPricing(root, { title: "Pricing plans", tone: "calm" });
    await ok(root, "sync");
    rmSync(dist, { recursive: true, force: true });
    await ok(root, "build");
    const full = join(root, "dist-full");
    cpSync(dist, full, { recursive: true });

    rmSync(dist, { recursive: true, force: true });
    cpSync(before, dist, { recursive: true });
    const second = await ok(root, "build", "--incremental");
    return { full, second: dist, err: second.err };
  })();
  return clean;
}

test("a no-drift incremental build is byte-identical to a build with the mechanism absent", async () => {
  const { full, second, err } = await cleanEdit();

  expect(err).not.toContain("Class drift");
  expect(existsSync(join(second, "pricing", "index.html"))).toBe(true);
  expect(readFileSync(join(second, "pricing", "index.html"), "utf8")).toContain(
    "Pricing plans",
  );
  for (const page of ["index.html", join("pricing", "index.html")]) {
    expect(readFileSync(join(second, page), "utf8")).not.toMatch(/<style[\s>]/);
  }

  const differences = diffOutputTrees(full, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");
}, 360_000);
