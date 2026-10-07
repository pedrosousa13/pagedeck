import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { classesOfHtml } from "./classes.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const SITE = join(SITES, ".pagedeck-classes-test");

const ESCAPED_CLASS = "[&>svg]:mt-2";

// The double space and the newline are deliberate: React writes them through, and a
// split on one space alone would read two classes as one.
const COMPONENTS: Record<string, string> = {
  "Hero.js": `import { createElement } from "react";
export default function Hero() {
  return createElement(
    "section",
    { className: "fw-hero  fw-hero--lead\\nfw-hero__inner" },
    "marker-hero-3c81",
  );
}
`,
  "Chart.js": `import { createElement } from "react";
export default function Chart() {
  return createElement(
    "div",
    { className: "fw-chart ${ESCAPED_CLASS}" },
    "marker-chart-7f24",
  );
}
`,
  "Copy.js": `export default function Copy() { return "marker-copy-8b70 not-a-class-4e19"; }\n`,
};

const RENDERED_CLASSES = [
  ESCAPED_CLASS,
  "fw-chart",
  "fw-hero",
  "fw-hero--lead",
  "fw-hero__inner",
];

function site(root: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, title] of [
    ["home", "Home"],
    ["pricing", "Pricing"],
    ["about", "About"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
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
      Chart: { path: "./components/Chart.js", hydrate: "visible" },
      Copy: "./components/Copy.js",
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: (page) => ({
      tree:
        page.path === "/"
          ? [{ component: "Hero" }, { component: "Chart" }]
          : page.path === "/pricing"
            ? [{ component: "Hero" }]
            : [{ component: "Copy" }],
    }),
  },
});
`,
  );
  return root;
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
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
}

const built = buildOnce();

async function buildOnce(): Promise<Built> {
  const dir = site(SITE);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const htmlOf = new Map(
    manifest.pages.map((page) => [
      page.path,
      readFileSync(join(dist, page.html), "utf8"),
    ]),
  );
  return { manifest, htmlOf };
}

test("a full build records every class its pages rendered, and no other", async () => {
  const { manifest } = await built;

  expect(manifest.classes).toEqual(RENDERED_CLASSES);
  expect([...manifest.classes]).toEqual([...manifest.classes].sort());
  expect(new Set(manifest.classes).size).toBe(manifest.classes.length);
}, 60_000);

test("a token the page holds as text is not a class", async () => {
  const { manifest, htmlOf } = await built;

  expect(htmlOf.get("/about")).toContain("not-a-class-4e19");
  expect(manifest.classes).not.toContain("not-a-class-4e19");
  expect(manifest.classes).not.toContain("marker-copy-8b70");
}, 60_000);

test("no emitted document holds a class the manifest does not", async () => {
  const { manifest, htmlOf } = await built;

  const recorded = new Set(manifest.classes);
  for (const [path, html] of htmlOf) {
    const unrecorded = classesOfHtml(html).filter((one) => !recorded.has(one));
    expect([path, unrecorded]).toEqual([path, []]);
  }

  expect(classesOfHtml(htmlOf.get("/") ?? "")).toContain("fw-hero");
}, 60_000);

test("a class React escaped is recorded as the stylesheet spells it", async () => {
  const { manifest, htmlOf } = await built;

  expect(htmlOf.get("/")).toContain("[&amp;&gt;svg]:mt-2");
  expect(manifest.classes).toContain(ESCAPED_CLASS);
  expect(manifest.classes).not.toContain("[&amp;&gt;svg]:mt-2");
}, 60_000);
