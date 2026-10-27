// @vitest-environment jsdom
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { EntryPlan } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";
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

async function build(
  islandErrors?: string,
  release = RELEASE,
): Promise<ClientBuild> {
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
    ...(islandErrors === undefined
      ? {}
      : { islandErrors: { module: islandErrors, release } }),
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
  return `<fw-island data-fw-prefix="${prefix}" data-fw-component="${component}" data-fw-mode="load" data-fw-props="${props}">${html}</fw-island>`;
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
  expect(declared).toContain(RELEASE);
  expect(without).not.toContain("__islandReports");
  expect(without).not.toContain("module-load");
  expect(without).not.toContain(RELEASE);
}, 120_000);

test("a new release renames only the page entry chunks, so the shared chunks stay cached", async () => {
  const first = await build("./src/report.js", "release-one");
  const second = await build("./src/report.js", "release-two");
  const entries = new Set([
    ...first.entryScripts.values(),
    ...second.entryScripts.values(),
  ]);
  const shared = (built: ClientBuild): string[] =>
    built.files
      .filter((file) => !entries.has(file.path))
      .map((file) => file.path)
      .sort();

  expect(shared(second)).toEqual(shared(first));
  expect([...second.entryScripts.values()]).not.toEqual([
    ...first.entryScripts.values(),
  ]);
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
