import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checkDrift } from "./drift.js";
import type { DriftReport } from "./drift.js";
import { EXIT_CODES } from "./exit.js";
import { headElements } from "./head.js";
import { pageKey } from "./incremental.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import type { Page } from "./pages.js";
import { compileSupplements } from "./supplement.js";

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
    "marker-hero-6d31 " + title,
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
    "marker-badge-2f71",
  );
}
`,
  "Badge.css": `.fw-badge { color: rgb(41, 42, 43); }\n`,
  "global.css": `.fw-global { color: rgb(51, 52, 53); }\n`,
};

const FULL_SITE = join(SITES, ".pagedeck-supplement-full-test");
const CLEAN_SITE = join(SITES, ".pagedeck-supplement-clean-test");
const ROGUE_SITE = join(SITES, ".pagedeck-supplement-rogue-test");

function site(root: string, tone: string, title: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, data] of [
    ["home", { title: "Home" }],
    ["pricing", { title, tone }],
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

afterAll(() => {
  for (const root of [FULL_SITE, CLEAN_SITE, ROGUE_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function run(cwd: string, ...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

interface Built {
  manifest: Manifest;
  htmlOf: Map<string, string>;
  cssOf: Map<string, string>;
}

async function build(root: string): Promise<Built> {
  await run(root, "sync");
  await run(root, "build");
  const dist = join(root, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return {
    manifest,
    htmlOf: new Map(
      manifest.pages.map((page) => [
        pageKey(page),
        readFileSync(join(dist, page.html), "utf8"),
      ]),
    ),
    cssOf: new Map(
      manifest.files
        .filter((one) => one.kind === "css")
        .map((one) => [one.path, readFileSync(join(dist, one.path), "utf8")]),
    ),
  };
}

const full = build(site(FULL_SITE, "calm", "Pricing"));
const clean = build(site(CLEAN_SITE, "calm", "Pricing plans"));
const rogue = build(site(ROGUE_SITE, "rogue", "Pricing"));

beforeAll(async () => {
  for (const built of [await full, await clean, await rogue]) {
    for (const [key, html] of built.htmlOf) {
      expect(html, `${key} emits an inlined <style>`).not.toMatch(/<style[\s>]/);
    }
  }
}, 60_000);

function pageOf(row: Manifest["pages"][number]): Page {
  return {
    locale: row.locale,
    path: row.path as `/${string}`,
    output: row.output,
    ...(row.collection === undefined ? {} : { collection: row.collection }),
    ...(row.entry === undefined ? {} : { entry: row.entry }),
    dependencies: row.dependencies,
  };
}

// Hands `checkDrift` emitted documents, not render fragments: sound only while no
// fixture declares `build.criticalCss`.
function driftOf(pinned: Manifest, next: Built): DriftReport {
  return checkDrift({
    pinned: pinned.classes,
    rendered: next.manifest.pages.map((page) => ({
      affected: {
        page: pageOf(page),
        reasons: [
          {
            kind: "own-entry" as const,
            ref: {
              collection: "pages",
              locale: page.locale,
              path: (page.entry as { path: string }).path,
            },
          },
        ],
      },
      html: next.htmlOf.get(pageKey(page)) ?? "",
    })),
  });
}

function fakeCompiler(classes: readonly string[]): string {
  return classes.map((name) => `.${name}{--fw-supplement:1}`).join("");
}

function linkedStyles(html: string): string[] {
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]*)">/g)].map(
    (match) => match[1] ?? "",
  );
}

function headInput(html: string): Parameters<typeof headElements>[0] {
  return {
    head: undefined,
    styles: linkedStyles(html),
    inlineStyles: [],
    links: undefined,
    absorbed: [],
  };
}

// No `supplement` key at all: a comparison whose two sides are one expression compares
// nothing.
function headWithoutSupplement(html: string): readonly string[] {
  return headElements(headInput(html));
}

// The field is passed for every page, `undefined` included, as the real writer gets it,
// so `headElements`' own guard is what is under test.
function headWithSupplement(
  html: string,
  supplement: string | undefined,
): readonly string[] {
  return headElements({ ...headInput(html), supplement });
}

test("a rogue class in a fixture entry drifts that page only", async () => {
  const [first, second] = [await full, await rogue];

  expect(first.manifest.classes).toContain("badge-calm");
  expect(first.manifest.classes).not.toContain("badge-rogue");
  expect(second.htmlOf.get("en /pricing")).toContain("badge-rogue");

  const report = driftOf(first.manifest, second);
  expect(report.pages.map((one) => pageKey(one.page))).toEqual(["en /pricing"]);
  expect(report.pages[0]?.classes).toEqual(["badge-rogue"]);
}, 60_000);

test("the drifted page inlines a supplement holding only its own missing rules", async () => {
  const [first, second] = [await full, await rogue];

  const result = await compileSupplements({
    report: driftOf(first.manifest, second),
    compile: fakeCompiler,
  });

  expect([...result.styles.keys()]).toEqual(["en /pricing"]);
  expect(result.styles.get("en /pricing")).toBe(
    "<style>.badge-rogue{--fw-supplement:1}</style>",
  );
  expect(result.warnings).toEqual([]);
}, 60_000);

test("a drifted build's stylesheets are the undrifted build's, byte for byte", async () => {
  const [first, second] = [await full, await rogue];

  const report = driftOf(first.manifest, second);
  expect(report.pages.map((one) => pageKey(one.page))).toEqual(["en /pricing"]);
  expect([...second.cssOf.keys()].length).toBeGreaterThan(1);
  expect(second.cssOf).toEqual(first.cssOf);

  const result = await compileSupplements({ report, compile: fakeCompiler });

  const page = second.htmlOf.get("en /pricing") ?? "";
  expect(
    headWithSupplement(page, result.styles.get("en /pricing")).join(""),
  ).toContain("--fw-supplement");
  for (const css of second.cssOf.values()) {
    expect(css).not.toContain("--fw-supplement");
  }
}, 60_000);

test("a no-drift incremental build composes every head it would have composed without this feature", async () => {
  const [first, second, drifted] = [await full, await clean, await rogue];

  expect(second.htmlOf.get("en /pricing")).not.toBe(
    first.htmlOf.get("en /pricing"),
  );
  const report = driftOf(first.manifest, second);
  expect(report.pages).toEqual([]);

  const result = await compileSupplements({ report, compile: fakeCompiler });
  expect(result.styles.size).toBe(0);
  expect(result.warnings).toEqual([]);

  // The element list rather than the joined string: an empty supplement is one more child
  // that concatenates to nothing.
  for (const [key, html] of second.htmlOf) {
    expect(headWithSupplement(html, result.styles.get(key))).toEqual(
      headWithoutSupplement(html),
    );
  }

  const home = second.htmlOf.get("en /") ?? "";
  expect(headWithSupplement(home, "")).not.toEqual(headWithoutSupplement(home));
  expect(headWithSupplement(home, "").join("")).toEqual(
    headWithoutSupplement(home).join(""),
  );

  const supplements = await compileSupplements({
    report: driftOf(first.manifest, drifted),
    compile: fakeCompiler,
  });
  const page = drifted.htmlOf.get("en /pricing") ?? "";
  expect(supplements.styles.get("en /pricing")).toBeDefined();
  expect(
    headWithSupplement(page, supplements.styles.get("en /pricing")),
  ).not.toEqual(headWithoutSupplement(page));
}, 60_000);

test("an undrifted page in a drifted build keeps its head, and the drifted page's grows by the supplement alone", async () => {
  const [first, second] = [await full, await rogue];

  const result = await compileSupplements({
    report: driftOf(first.manifest, second),
    compile: fakeCompiler,
  });

  const drifted = second.htmlOf.get("en /pricing") ?? "";
  const supplement = result.styles.get("en /pricing");
  expect(supplement).toBeDefined();
  const withFeature = headWithSupplement(drifted, supplement);
  const without = headWithoutSupplement(drifted);
  expect(withFeature).not.toEqual(without);
  expect(withFeature).toEqual([...without, supplement]);

  const home = second.htmlOf.get("en /") ?? "";
  expect(result.styles.get("en /")).toBeUndefined();
  expect(headWithSupplement(home, result.styles.get("en /"))).toEqual(
    headWithoutSupplement(home),
  );
}, 60_000);
