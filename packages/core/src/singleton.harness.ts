// Opt-in: `pnpm build && pnpm test:singleton-harness`. Chromium, because jsdom silently
// ignores `<script type="module">`; `@pagedeck/islands` runs out of `dist`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page as BrowserPage } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";
import { islandMarker } from "./tree.js";
import type { AnyComponent } from "./tree.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-singleton-harness/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const RUNTIME_DIST = fileURLToPath(
  new URL("../../islands/dist/runtime.js", import.meta.url),
);

const UNWRITTEN = "store-unwritten";
const WRITTEN = "written-by-Hero";
const WRITTEN_BY_CHART = "written-by-Chart";

const HERO_PREFIX = "harness-hero";
const CHART_PREFIX = "harness-chart";

// `createElement` in `.js` files, so the modules the bundler compiles are the ones this
// harness imports for the server HTML.
const FIXTURE: Record<string, string> = {
  "store.js": `let value = ${JSON.stringify(UNWRITTEN)};
const listeners = new Set();
export const initial = () => ${JSON.stringify(UNWRITTEN)};
export const read = () => value;
export function subscribe(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function write(next) {
  value = next;
  for (const listener of listeners) listener();
}
`,
  "Hero.js": `import { createElement, useEffect, useSyncExternalStore } from "react";
import { initial, read, subscribe, write } from "./store.js";
export default function Hero() {
  // useSyncExternalStore on purpose: with another hook, React's mismatch repair passes the assertion for the wrong reason.
  const value = useSyncExternalStore(subscribe, read, initial);
  useEffect(() => { write(${JSON.stringify(WRITTEN)}); }, []);
  return createElement("p", { id: "hero-value" }, value);
}
`,
  "Chart.js": `import { createElement, useSyncExternalStore } from "react";
import { initial, read, subscribe, write } from "./store.js";
export default function Chart() {
  const value = useSyncExternalStore(subscribe, read, initial);
  return createElement("div", null,
    createElement("p", { id: "chart-value" }, value),
    createElement("button", {
      id: "chart-write",
      onClick: () => { write(${JSON.stringify(WRITTEN_BY_CHART)}); },
    }, "write"),
  );
}
`,
  "Nav.js": `import { createElement } from "react";
export default function Nav() {
  return createElement("nav", null, "nav");
}
`,
};

const MODULES = {
  Hero: "./src/Hero.js",
  Nav: "./src/Nav.js",
  Chart: "./src/Chart.js",
};

function demand(
  path: `/${string}`,
  output: string,
  components: readonly string[],
): PageDemand {
  const page: Page = { locale: "en", path, output, dependencies: [] };
  return {
    page,
    islands: components.map((component) => ({
      component,
      mode: "visible" as const,
    })),
  };
}

const DEMANDS: readonly PageDemand[] = [
  demand("/", "/en", ["Hero", "Nav"]),
  demand("/pricing", "/en/pricing", ["Hero", "Nav"]),
  demand("/about", "/en/about", ["Hero", "Nav"]),
  demand("/blog", "/en/blog", ["Hero", "Nav"]),
  demand("/careers", "/en/careers", ["Hero", "Nav", "Chart"]),
];

const ENTRY_NAME = careersEntryName();

function careersEntryName(): string {
  const plan = planEntries(DEMANDS, { modules: MODULES });
  const found = plan.entries.find((entry) => entry.path === "/careers");
  if (found === undefined) {
    throw new Error(
      "Singleton harness: the entry plan holds no entry for en /careers, so there is no page to load — give /careers an island in DEMANDS",
      { cause: new Error(`planned: ${plan.entries.map((entry) => `${entry.locale} ${entry.path}`).join(", ")}`) },
    );
  }
  return found.name;
}
const PAGE_URL = "https://singleton.harness.invalid/en/careers";

let build: ClientBuild;
let browser: Browser;
let heroHtml: string;
let chartHtml: string;

function checkRuntimeBuilt(): void {
  if (existsSync(RUNTIME_DIST)) return;
  throw new Error(
    `Singleton harness: "${RUNTIME_DIST}" is not there, so the emitted chunks would import no islands runtime — run pnpm build first`,
  );
}

async function islandHtml(file: string, prefix: string): Promise<string> {
  const module = (await import(`${SRC}${file}`)) as { default: AnyComponent };
  return renderToString(createElement(module.default, {}), {
    identifierPrefix: prefix,
  });
}

beforeAll(async () => {
  checkRuntimeBuilt();
  mkdirSync(SRC, { recursive: true });
  for (const [file, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${file}`, source);
  }
  writeFileSync(ORIGIN, "export default {};\n");

  const plan = planEntries(DEMANDS, { modules: MODULES });
  build = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [], policy: { minSize: 0 } }),
  });

  heroHtml = await islandHtml("Hero.js", HERO_PREFIX);
  chartHtml = await islandHtml("Chart.js", CHART_PREFIX);
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser.close();
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function marker(
  component: string,
  mode: "load" | "visible",
  prefix: string,
  html: string,
): string {
  return renderToStaticMarkup(
    islandMarker({ island: { component, mode, prefix, html }, props: "{}" }, "0"),
  );
}

// Four viewports of spacer, so `visible` hydrates later than `load` rather than at once.
function pageHtml(modes: { hero: "load" | "visible"; chart: "load" | "visible" }): string {
  const script = build.entryScripts.get(ENTRY_NAME);
  if (script === undefined) {
    throw new Error(
      `Singleton harness: the build emitted no entry chunk named "${ENTRY_NAME}", so the page has no script to run — check the fixture's pages still plan an entry under that name`,
    );
  }
  return [
    "<!doctype html><html><head><title>singleton harness</title></head><body>",
    marker("Hero", modes.hero, HERO_PREFIX, heroHtml),
    '<div style="height:400vh">spacer</div>',
    marker("Chart", modes.chart, CHART_PREFIX, chartHtml),
    `<script type="module" src="${script}"></script>`,
    "</body></html>",
  ].join("");
}

async function open(modes: {
  hero: "load" | "visible";
  chart: "load" | "visible";
}): Promise<{ page: BrowserPage; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  // A hydration mismatch is only a `console.error`, and React's re-render often repairs
  // the DOM, so a test could otherwise read a thrown-away root.
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  const html = pageHtml(modes);
  const byPath = new Map(build.files.map((file) => [file.path, file.contents]));
  const pathname = new URL(PAGE_URL).pathname;
  await page.route("**/*", async (route) => {
    const requested = new URL(route.request().url()).pathname;
    if (requested === pathname) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      return;
    }
    const contents = byPath.get(requested);
    if (contents === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: `Singleton harness: no emitted file at ${requested}`,
      });
      return;
    }
    await route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: typeof contents === "string" ? contents : Buffer.from(contents),
    });
  });
  await page.goto(PAGE_URL);
  return { page, errors };
}

function chunksHolding(id: string): string[] {
  return [...build.modules]
    .filter(([, ids]) => ids.includes(id))
    .map(([path]) => path);
}

function tiersAreSeparate(): void {
  const core = build.files.find((file) => file.name === "fw-core");
  expect(core).toBeDefined();
  const coreIds = build.modules.get(core?.path ?? "") ?? [];
  expect(coreIds).toContain(`${SRC}Hero.js`);
  expect(coreIds).not.toContain(`${SRC}Chart.js`);
  expect(chunksHolding(`${SRC}Chart.js`)).toHaveLength(1);
  expect(chunksHolding(`${SRC}store.js`)).toHaveLength(1);
}

test("two islands in two tier groups share one store instance", async () => {
  tiersAreSeparate();
  const { page, errors } = await open({ hero: "load", chart: "load" });

  await expect
    .poll(() => page.locator("#hero-value").textContent(), { timeout: 30_000 })
    .toBe(WRITTEN);
  await expect
    .poll(() => page.locator("#chart-value").textContent(), { timeout: 30_000 })
    .toBe(WRITTEN);

  await page.locator("#chart-write").click();
  await expect
    .poll(() => page.locator("#hero-value").textContent(), { timeout: 30_000 })
    .toBe(WRITTEN_BY_CHART);
  expect(await page.locator("#chart-value").textContent()).toBe(
    WRITTEN_BY_CHART,
  );

  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

test("the later island under a different strategy observes the earlier one's write", async () => {
  tiersAreSeparate();
  const { page, errors } = await open({ hero: "load", chart: "visible" });

  await expect
    .poll(() => page.locator("#hero-value").textContent(), { timeout: 30_000 })
    .toBe(WRITTEN);

  expect(await page.locator("#chart-value").textContent()).toBe(UNWRITTEN);

  await page.locator("#chart-value").scrollIntoViewIfNeeded();

  await expect
    .poll(() => page.locator("#chart-value").textContent(), { timeout: 30_000 })
    .toBe(WRITTEN);

  expect(errors).toEqual([]);
  await page.close();
}, 120_000);
