// @vitest-environment jsdom
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { EntryPlan } from "./entries.js";
import { diffOutputTrees } from "./determinism.js";
import { ConfigError, EXIT_CODES } from "./exit.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_TAG,
} from "@pagedeck/islands";
import type { IslandErrorReport } from "@pagedeck/islands";

declare const document: {
  body: { innerHTML: string };
  documentElement: { lang: string };
};
declare const history: {
  replaceState(state: unknown, unused: string, url: string): void;
};

// A path, not `new URL`: jsdom replaces the global `URL`, which `fileURLToPath`
// refuses.
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/.pagedeck-island-errors-test/",
);
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;
const RELEASE = "4b7e0c1a-island-errors-release";
const SENTINEL = "sentinel-prop-93d0";

const MODULES = {
  PricingTable: "./src/PricingTable.js",
  Newsletter: "./src/Newsletter.js",
};

interface Reports {
  __islandReports?: IslandErrorReport[];
}

beforeAll(() => {
  mkdirSync(`${FIXTURE_DIR}src`, { recursive: true });
  writeFileSync(
    `${FIXTURE_DIR}src/PricingTable.js`,
    `export default function PricingTable() { return "client text"; }\n`,
  );
  writeFileSync(
    `${FIXTURE_DIR}src/Newsletter.js`,
    `export default function Newsletter() { return "newsletter-6c2f"; }\n`,
  );
  writeFileSync(
    `${FIXTURE_DIR}src/report.js`,
    `export default function report(report) { (globalThis.__islandReports ??= []).push(report); }\n`,
  );
  writeFileSync(ORIGIN, "export default {};\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function page(path: `/${string}`): Page {
  return { locale: "en", path, output: `/en${path}/`, dependencies: [] };
}

function plan(): EntryPlan {
  return planEntries(
    [
      {
        page: page("/pricing"),
        islands: [
          { component: "PricingTable", mode: "load" },
          { component: "Newsletter", mode: "load" },
        ],
      },
    ],
    { modules: MODULES },
  );
}

async function build(islandErrors?: string): Promise<ClientBuild> {
  const entries = plan();
  return buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    // Out of the tiers, so the island's module is a chunk of its own to lose.
    tiers: planTiers({
      entries: entries.entries,
      ranking: [],
      policy: { exclude: ["Newsletter"] },
    }),
    ...(islandErrors === undefined ? {} : { islandErrors }),
  });
}

function javascript(built: ClientBuild): string {
  return built.files
    .filter((file) => file.kind === "js")
    .map((file) => String(file.contents))
    .join("\n");
}

function marker(component: string, prefix: string, html: string): string {
  const props = JSON.stringify({ secret: SENTINEL }).replaceAll('"', "&quot;");
  return `<${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="${prefix}" ${ISLAND_COMPONENT_ATTRIBUTE}="${component}" ${ISLAND_MODE_ATTRIBUTE}="load" ${ISLAND_PROPS_ATTRIBUTE}="${props}">${html}</${ISLAND_TAG}>`;
}

test("a hydration mismatch and a failed island module reach the declared reporter with page, component and release", async () => {
  const built = await build("./src/report.js");
  const dir = join(FIXTURE_DIR, "site");
  rmSync(dir, { recursive: true, force: true });
  for (const file of built.files) {
    const path = join(dir, file.path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.contents);
  }
  const newsletter = built.files.find((file) =>
    file.path.startsWith("/assets/Newsletter-"),
  );
  expect(newsletter).toBeDefined();
  rmSync(join(dir, newsletter?.path ?? ""));

  document.documentElement.lang = "en";
  history.replaceState(null, "", "/en/pricing/");
  document.body.innerHTML =
    marker("PricingTable", "i1", "<p>server text</p>") +
    marker("Newsletter", "i2", "newsletter-6c2f");
  const reports: IslandErrorReport[] = [];
  (globalThis as Reports).__islandReports = reports;
  const reportError = vi.fn();
  vi.stubGlobal("reportError", reportError);
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return new Response(JSON.stringify({ build: { id: RELEASE } }));
  });

  // The runtime leaves a failed load's rejection unhandled, as a browser logs
  // it; the runner would fail the file on it.
  const runner = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const unhandled: unknown[] = [];
  process.on("unhandledRejection", (reason) => {
    unhandled.push(reason);
  });
  try {
    const entry = built.entryScripts.get(plan().entries[0]?.name ?? "");
    await import(/* @vite-ignore */ pathToFileURL(join(dir, entry ?? "")).href);
    await vi.waitFor(() => {
      expect(reports.map((report) => report.kind).sort()).toEqual([
        "module-load",
        "recoverable",
      ]);
    });
    await vi.waitFor(() => {
      expect(unhandled).toHaveLength(1);
    });
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of runner) process.on("unhandledRejection", listener);
    vi.unstubAllGlobals();
  }

  const byKind = new Map(reports.map((report) => [report.kind, report]));
  expect(byKind.get("recoverable")).toMatchObject({
    page: { locale: "en", path: "/en/pricing/" },
    component: "PricingTable",
    release: RELEASE,
  });
  expect(byKind.get("module-load")).toMatchObject({
    page: { locale: "en", path: "/en/pricing/" },
    component: "Newsletter",
    release: RELEASE,
  });
  expect(unhandled[0]).toBe(byKind.get("module-load")?.error);
  expect(fetched).toEqual(["/manifest.json"]);
  expect(reportError).toHaveBeenCalledWith(byKind.get("recoverable")?.error);
  for (const report of reports) {
    const { error: _error, ...context } = report;
    expect(JSON.stringify(context)).not.toContain(SENTINEL);
  }
}, 120_000);

test("a build with no reporter declared bundles none of the reporting module", async () => {
  const without = javascript(await build());
  const declared = javascript(await build("./src/report.js"));

  expect(declared).toContain("__islandReports");
  expect(declared).toContain("/manifest.json");
  expect(without).not.toContain("__islandReports");
  expect(without).not.toContain("module-load");
  expect(without).not.toContain("/manifest.json");
}, 120_000);

test("the reporter is a chunk of its own, which the entry loads with a dynamic import", async () => {
  const built = await build("./src/report.js");
  const holding = built.files.filter(
    (file) => file.kind === "js" && String(file.contents).includes("__islandReports"),
  );

  expect(holding).toHaveLength(1);
  expect([...built.entryScripts.values()]).not.toContain(holding[0]?.path);
  const name = holding[0]?.path.slice(holding[0].path.lastIndexOf("/") + 1);
  expect(javascript(built)).toMatch(
    new RegExp(`import\\(["'\`][^"'\`]*${name?.replaceAll(".", "\\.")}["'\`]\\)`),
  );
}, 120_000);

test("a reporter module that does not resolve is refused with the field and its path", async () => {
  const failure = await build("./src/missing-report.js").catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toBe(
    `Client build: "build.islandErrors" names "./src/missing-report.js", which did not resolve against "${ORIGIN}" — correct the path, which is read from the config's directory, or install the package it names`,
  );
}, 120_000);

test("a reporter specifier the resolver throws on is refused with the resolver's error as its cause", async () => {
  const pkg = join(FIXTURE_DIR, "node_modules", "reporter-package-7d1c");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "reporter-package-7d1c", type: "module", exports: { ".": "./index.js" } }),
  );
  writeFileSync(join(pkg, "index.js"), "export default function report() {}\n");

  const failure = await build("reporter-package-7d1c/missing").catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toContain(
    `"build.islandErrors" names "reporter-package-7d1c/missing", which did not resolve`,
  );
  expect((failure as Error).cause).toBeInstanceOf(Error);
}, 120_000);

const TWICE_SITE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/.pagedeck-island-errors-twice-test/",
);
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

function writeTwiceSite(): void {
  rmSync(TWICE_SITE, { recursive: true, force: true });
  mkdirSync(join(TWICE_SITE, "components"), { recursive: true });
  mkdirSync(join(TWICE_SITE, "content", "en"), { recursive: true });
  writeFileSync(
    join(TWICE_SITE, "components", "Counter.js"),
    `"use client";\nexport default function Counter() { return "marker-counter-1f7a"; }\n`,
  );
  writeFileSync(
    join(TWICE_SITE, "report.js"),
    `export default function report(report) { (globalThis.__islandReports ??= []).push(report); }\n`,
  );
  writeFileSync(
    join(TWICE_SITE, "content", "en", "index.json"),
    `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`,
  );
  writeFileSync(
    join(TWICE_SITE, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(TWICE_SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: [fromCollection(pages)],
    components: { Counter: "./components/Counter.js" },
    islandErrors: "./report.js",
    content: () => ({ tree: [{ component: "Counter" }] }),
  },
});
`,
  );
}

async function runIn(cwd: string, verb: string): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli([verb], {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

afterAll(() => {
  rmSync(TWICE_SITE, { recursive: true, force: true });
});

test("two builds of one site with a reporter declared differ only in the manifest's build stamp", async () => {
  writeTwiceSite();
  const dist = join(TWICE_SITE, "dist");
  const first = join(TWICE_SITE, "first");
  await runIn(TWICE_SITE, "sync");
  await runIn(TWICE_SITE, "build");
  cpSync(dist, first, { recursive: true });
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(TWICE_SITE, ".pagedeck"), { recursive: true, force: true });
  await runIn(TWICE_SITE, "build");

  const stamp = (root: string): string =>
    (
      JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
        build: { id: string };
      }
    ).build.id;
  expect(stamp(dist)).not.toBe(stamp(first));
  expect(diffOutputTrees(first, dist)).toEqual([]);

  const index = readFileSync(join(dist, "index.html"), "utf8");
  expect(index).toContain(`<${ISLAND_TAG}`);
  expect(index).not.toContain(stamp(dist));
  expect(index).not.toContain(stamp(first));
  const assets = readdirSync(join(dist, "assets")).map((file) =>
    readFileSync(join(dist, "assets", file), "utf8"),
  );
  expect(assets.some((chunk) => chunk.includes("__islandReports"))).toBe(true);
  expect(assets.some((chunk) => chunk.includes("/manifest.json"))).toBe(true);
}, 120_000);
