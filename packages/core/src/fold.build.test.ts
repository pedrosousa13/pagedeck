import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { budgetReportPath } from "./budgets.js";
import type { BudgetReport } from "./budgets.js";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Widget.js": `"use client";\nexport default function Widget() { return "marker-widget-4a71"; }\n`,
  "Pinned.js": `"use client";\nexport default function Pinned() { return "marker-pinned-88b0"; }\n`,
  "Eager.js": `export default function Eager() { return "marker-eager-13c5"; }\n`,
  "Filler.js": `export default function Filler() { return "marker-filler-6d2e"; }\n`,
};

// Four nodes, `DEFAULT_FOLD_THRESHOLD` exactly, nested rather than siblings: a walk
// that numbered top-level siblings would put `Widget` at 1 and fail here.
const LEADING_BLOCK = {
  component: "Filler",
  children: Array.from({ length: 3 }, () => ({ component: "Filler" })),
};

let siteCount = 0;
const written: string[] = [];

// A fresh directory per call: Node caches the config module by URL, so a reused
// path would build the first site's config.
function site(options: {
  foldStrategy?: string;
  budget?: Record<string, string>;
  tierPolicy?: string;
}): string {
  siteCount += 1;
  const root = join(SITES, `.pagedeck-fold-test-${String(siteCount)}`);
  written.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const path of ["home", "deep"]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { path } })}\n`);
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

const LEADING_BLOCK = ${JSON.stringify(LEADING_BLOCK)};

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
      Widget: "./components/Widget.js",
      Pinned: { path: "./components/Pinned.js", hydrate: "visible" },
      Eager: { path: "./components/Eager.js", hydrate: "load" },
      Filler: "./components/Filler.js",
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    // The islands are excluded so each keeps its own chunk, which a report row needs.
    tierPolicy: ${
      options.tierPolicy ??
      `{ minSize: 0, exclude: ["Widget", "Pinned", "Eager"] }`
    },${
      options.foldStrategy === undefined
        ? ""
        : `\n    foldStrategy: ${options.foldStrategy},`
    }${
      options.budget === undefined
        ? ""
        : `\n    budget: ${JSON.stringify(options.budget)},`
    }
    content: (page) => ({
      tree:
        page.path === "/"
          ? [{ component: "Widget" }, { component: "Pinned" }, { component: "Eager" }]
          : [LEADING_BLOCK, { component: "Widget" }, { component: "Eager" }],
    }),
  },
});
`,
  );
  return root;
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function run(
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; err: string }> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  return { code, err: err.join("\n") };
}

function manifestIn(dist: string): Manifest {
  return readManifest(readFileSync(join(dist, MANIFEST_FILE), "utf8"), "test");
}

function pageRow(manifest: Manifest, path: string) {
  const row = manifest.pages.find((page) => page.path === path);
  if (row === undefined) throw new Error(`no manifest row for ${path}`);
  return row;
}

function document(dist: string, output: string): string {
  return readFileSync(join(dist, output, "index.html"), "utf8");
}

test("a site that declares no foldStrategy is tuned per instance and per page", async () => {
  const dir = site({});
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const manifest = manifestIn(dist);

  const home = document(dist, "");
  expect(home).toContain('data-fw-component="Widget" data-fw-mode="load"');

  expect(home).toContain('data-fw-component="Pinned" data-fw-mode="visible"');

  const deep = document(dist, "/deep");
  expect(deep).toContain('data-fw-component="Eager" data-fw-mode="visible"');
  expect(home).toContain('data-fw-component="Eager" data-fw-mode="load"');

  expect(deep).toContain('data-fw-component="Widget" data-fw-mode="visible"');

  expect(deep).not.toContain('data-fw-component="Filler"');

  expect(pageRow(manifest, "/").foldTuning).toEqual([
    { component: "Widget", position: 0, from: "visible", to: "load" },
  ]);
  expect(pageRow(manifest, "/deep").foldTuning).toEqual([
    { component: "Eager", position: 5, from: "load", to: "visible" },
  ]);
}, 60_000);

test("a site that turns foldStrategy off keeps every declared and defaulted mode", async () => {
  const dir = site({ foldStrategy: "false" });
  await run(dir, "sync");

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const home = document(dist, "");
  expect(home).toContain('data-fw-component="Widget" data-fw-mode="visible"');
  expect(home).toContain('data-fw-component="Eager" data-fw-mode="load"');
  expect(document(dist, "/deep")).toContain(
    'data-fw-component="Eager" data-fw-mode="load"',
  );
  const manifest = manifestIn(dist);
  expect(pageRow(manifest, "/").foldTuning).toEqual([]);
  expect(pageRow(manifest, "/deep").foldTuning).toEqual([]);
}, 60_000);

test("a promotion that breaches a page budget fails naming the promotion", async () => {
  const dir = site({ budget: { "/": "1b", "/deep": "500kb" } });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows",
  );
  expect(result.err).toContain(
    'fold strategy promoted "Widget" at tree position 0 from "visible" to "load" — position 0 is above the fold threshold of 4',
  );

  const report = JSON.parse(
    readFileSync(budgetReportPath(dir), "utf8"),
  ) as BudgetReport;
  const home = report.pages.find((page) => page.path === "/");
  expect(home?.causes).toEqual([
    'fold strategy promoted "Widget" at tree position 0 from "visible" to "load" — position 0 is above the fold threshold of 4',
  ]);
  expect(
    report.pages.find((page) => page.path === "/deep")?.causes,
  ).toEqual([
    'fold strategy demoted "Eager" at tree position 5 from "load" to "visible" — position 5 is below the fold threshold of 4',
  ]);
}, 60_000);

test("a promoted island's chunk is counted against the page's budget", async () => {
  const dir = site({ budget: { "/": "500kb", "/deep": "500kb" } });
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const report = JSON.parse(
    readFileSync(budgetReportPath(dir), "utf8"),
  ) as BudgetReport;
  const chunksOf = (path: string): readonly string[] =>
    report.pages.find((page) => page.path === path)?.chunks.map((c) => c.path) ??
    [];

  expect(chunksOf("/").filter((path) => path.includes("/Widget-"))).toHaveLength(
    1,
  );
  expect(
    chunksOf("/deep").filter((path) => path.includes("/Widget-")),
  ).toHaveLength(0);
  expect(
    chunksOf("/deep").filter((path) => path.includes("/Eager-")),
  ).toHaveLength(0);
  expect(chunksOf("/").filter((path) => path.includes("/Eager-"))).toHaveLength(
    1,
  );
}, 60_000);

test("an island fold strategy promotes to load is tiered", async () => {
  const dir = site({ tierPolicy: `{ minSize: 0, exclude: ["Eager"] }` });
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const manifest = manifestIn(dist);
  expect(pageRow(manifest, "/").foldTuning).toContainEqual({
    component: "Widget",
    position: 0,
    from: "visible",
    to: "load",
  });
  expect(
    manifest.tiers.assignments.find((one) => one.component === "Widget"),
  ).toMatchObject({ tier: "core", group: "fw-core", pageCount: 2 });
  const core = manifest.files.find((file) =>
    /^\/assets\/fw-core-[\w-]+\.js$/.test(file.path),
  );
  expect(core).toBeDefined();
  expect(readFileSync(join(dist, core?.path ?? ""), "utf8")).toContain(
    "marker-widget-4a71",
  );
}, 60_000);
