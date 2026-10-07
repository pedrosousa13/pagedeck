import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import { planEntries } from "./entries.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import { planTiers } from "./tiers.js";
import type { PageDemand } from "./entries.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

// The stack's marker is a prop: an exported constant nothing reads is shaken out
// even when its module is in the graph.
const STORE_MARKER = "fw-store-7c31";
const PROVIDERS_MARKER = "fw-providers-2a55";
const HERO_MARKER = "marker-hero-5c14";
const CHART_MARKER = "marker-chart-9b70";

// Plain JavaScript: `pagedeck.config.ts` imports `providers.js` in plain Node, which strips
// types but does not transform JSX.
const MODULES: Record<string, string> = {
  "store.js": `import { createContext, createElement } from "react";
export const StoreContext = createContext(null);
let count = 0;
export const store = {
  read: () => "${STORE_MARKER}:" + String(count),
  write: (next) => { count = next; },
};
export function StoreProvider({ store, children }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}
`,
  "providers.js": `import { StoreProvider, store } from "./store.js";
export default [{ component: StoreProvider, props: { store, marker: "${PROVIDERS_MARKER}" } }];
`,
  "Hero.js": `import { useContext } from "react";
import { StoreContext } from "./store.js";
export default function Hero() {
  const store = useContext(StoreContext);
  return "${HERO_MARKER} " + (store === null ? "no-store" : store.read());
}
`,
  "Chart.js": `import { useContext } from "react";
import { StoreContext } from "./store.js";
export default function Chart() {
  const store = useContext(StoreContext);
  return "${CHART_MARKER} " + (store === null ? "no-store" : store.read());
}
`,
};

const PLAIN_SITE = join(SITES, ".pagedeck-root-providers-plain-test");
const STACK_SITE = join(SITES, ".pagedeck-root-providers-stack-test");

const PAGES: readonly { path: string; chart: boolean }[] = [
  { path: "home", chart: false },
  { path: "pricing", chart: false },
  { path: "about", chart: false },
  { path: "blog", chart: false },
  { path: "careers", chart: true },
];

function site(root: string, stack = ""): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(MODULES)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const page of PAGES) {
    const file = join(root, "content", "en", `${page.path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ rev: 1, data: { title: page.path } })}\n`,
    );
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};
import providers from "./components/providers.js";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

const CHART_PAGES = ${JSON.stringify(PAGES.filter((page) => page.chart).map((page) => page.path))};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${stack}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, { route: (entry) => "/" + entry.path }),
      ],
    }),
    // Both are above the fold on these two-node trees, so fold tuning moves neither.
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "load" },
      Chart: { path: "./components/Chart.js", hydrate: "visible" },
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: (page) => ({
      tree: CHART_PAGES.includes(page.entry.path)
        ? [{ component: "Hero" }, { component: "Chart" }]
        : [{ component: "Hero" }],
    }),
  },
});
`,
  );
  return root;
}

const DECLARED_STACK = `rootProviders: { stack: providers, module: "./components/providers.js" },`;

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
  files: Map<string, string>;
  documents: Map<string, string>;
}

const builds = new Map<string, Promise<Built>>();

function build(root: string, stack = ""): Promise<Built> {
  let one = builds.get(root);
  if (one === undefined) {
    one = buildOnce(root, stack);
    builds.set(root, one);
  }
  return one;
}

async function buildOnce(root: string, stack: string): Promise<Built> {
  const dir = site(root, stack);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return {
    manifest,
    files: new Map(
      manifest.files.map((one) => [
        one.path,
        readFileSync(join(dist, one.path), "utf8"),
      ]),
    ),
    documents: new Map(
      manifest.pages.map((page) => [
        page.path,
        readFileSync(join(dist, page.html), "utf8"),
      ]),
    ),
  };
}

afterAll(() => {
  for (const root of [PLAIN_SITE, STACK_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function demands(): readonly PageDemand[] {
  return PAGES.map((page) => ({
    page: {
      locale: "en",
      path: `/${page.path}`,
      output: `/en/${page.path}`,
      dependencies: [],
    },
    islands: page.chart
      ? [
          { component: "Hero", mode: "load" as const },
          { component: "Chart", mode: "visible" as const },
        ]
      : [{ component: "Hero", mode: "load" as const }],
  }));
}

function chunksHolding(built: Built, marker: string): string[] {
  return [...built.files]
    .filter(([path, text]) => path.endsWith(".js") && text.includes(marker))
    .map(([path]) => path);
}

const CHECK_MARKER = "are not one declaration";
const PROBE_MARKER = "delivers a different value to each island root";

test("the digest ships and the probe does not", async () => {
  const stacked = await build(STACK_SITE, DECLARED_STACK);

  expect(chunksHolding(stacked, CHECK_MARKER)).toHaveLength(1);
  expect(chunksHolding(stacked, PROBE_MARKER)).toEqual([]);
  expect(
    chunksHolding(stacked, "stack[0] marker=string#").length,
  ).toBeGreaterThan(0);
  expect(chunksHolding(stacked, PROVIDERS_MARKER)).toHaveLength(1);

  const plan = planEntries(demands(), {
    modules: { Hero: "./components/Hero.js", Chart: "./components/Chart.js" },
    providers: "./components/providers.js",
    providersDigest: "stack[0] marker=string#0000",
  });
  const client = await buildClient({
    root: STACK_SITE,
    origin: join(STACK_SITE, "pagedeck.config.ts"),
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [] }),
  });
  const ids = [...client.modules.values()].flat();

  expect(ids.some((id) => id.includes("root-provider-check"))).toBe(true);
  for (const id of ids) expect(id).not.toContain("root-provider-probe");
}, 120_000);

test("a site with no stack ships neither the digest nor the probe", async () => {
  const plain = await build(PLAIN_SITE);

  expect(chunksHolding(plain, CHECK_MARKER)).toEqual([]);
  expect(chunksHolding(plain, PROBE_MARKER)).toEqual([]);
  expect(chunksHolding(plain, "stack[0]")).toEqual([]);
}, 120_000);

test("the configured stack wraps the page tree during the build-time render", async () => {
  const stacked = await build(STACK_SITE, DECLARED_STACK);

  expect(stacked.documents.get("/careers")).toContain(
    `${HERO_MARKER} ${STORE_MARKER}:0`,
  );
  expect(stacked.documents.get("/careers")).toContain(
    `${CHART_MARKER} ${STORE_MARKER}:0`,
  );
}, 120_000);

test("a site that configures no stack renders the page without one", async () => {
  const plain = await build(PLAIN_SITE);

  expect(plain.documents.get("/careers")).toContain(`${HERO_MARKER} no-store`);
  expect(plain.documents.get("/careers")).toContain(`${CHART_MARKER} no-store`);
}, 120_000);

test("the same stack reaches the client in one chunk, which both islands' chunks reach", async () => {
  const stacked = await build(STACK_SITE, DECLARED_STACK);

  const store = chunksHolding(stacked, STORE_MARKER);
  expect(store).toHaveLength(1);
  expect(chunksHolding(stacked, PROVIDERS_MARKER)).toEqual(store);

  const hero = chunksHolding(stacked, HERO_MARKER);
  const chart = chunksHolding(stacked, CHART_MARKER);
  expect(hero).toHaveLength(1);
  expect(chart).toHaveLength(1);
  expect(hero[0]).not.toBe(chart[0]);

  expect(store[0]).toContain("fw-core");
  expect(store[0]).toBe(hero[0]);
  expect(store[0]).not.toBe(chart[0]);

  for (const page of stacked.manifest.pages) {
    expect(page.providers).toBe("./components/providers.js");
  }

  const careers = stacked.manifest.pages.find((page) => page.path === "/careers");
  const entry = stacked.files.get(careers?.entryChunk ?? "") ?? "";
  expect(entry).not.toBe("");
  const chunkName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  expect(entry).toContain(chunkName(store[0] ?? ""));
}, 120_000);

test("zero configured providers costs zero bytes", async () => {
  const plain = await build(PLAIN_SITE);
  const stacked = await build(STACK_SITE, DECLARED_STACK);

  expect(chunksHolding(plain, PROVIDERS_MARKER)).toEqual([]);
  expect(chunksHolding(plain, STORE_MARKER)).toEqual([]);
  expect(plain.manifest.pages.map((page) => page.providers)).toEqual(
    plain.manifest.pages.map(() => undefined),
  );
  expect(JSON.stringify(plain.manifest.tiers)).not.toContain("providers.js");

  expect(plain.manifest.pages.map((page) => page.path)).toEqual(
    stacked.manifest.pages.map((page) => page.path),
  );
  expect(chunksHolding(plain, HERO_MARKER)).toHaveLength(1);
  expect(chunksHolding(plain, CHART_MARKER)).toHaveLength(1);
}, 120_000);
