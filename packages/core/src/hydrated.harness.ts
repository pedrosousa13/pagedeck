// Opt-in: `pnpm build && pnpm test:hydrated-harness`. Chromium, because jsdom ignores
// `<script type="module">`; `@pagedeck/islands` runs out of `dist`.
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
import type { PageEntry } from "./entries.js";
import { CORE_GROUP, planTiers } from "./tiers.js";
import { islandMarker } from "./tree.js";
import type { AnyComponent } from "./tree.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-hydrated-harness/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const RUNTIME_DIST = fileURLToPath(
  new URL("../../islands/dist/runtime.js", import.meta.url),
);

const PAGE_URL = "https://hydrated.harness.invalid/en/";

// Written as the wire format, not imported, so a rename fails here.
const LOAD_MARKER = 'pagedeck-island[data-pagedeck-component="Ticker"]';
const IDLE_MARKER = 'pagedeck-island[data-pagedeck-component="Clock"]';
const HYDRATED = "data-pagedeck-hydrated";

const CLOCK_TEXT = "clock-6f1e";

const FIXTURE: Record<string, string> = {
  "Clock.js": `import { createElement } from "react";
export default function Clock() {
  return createElement("p", { id: "clock" }, ${JSON.stringify(CLOCK_TEXT)});
}
`,
  "Ticker.js": `import { createElement } from "react";
export default function Ticker() {
  return createElement("p", { id: "ticker" }, "ticker-0b3a");
}
`,
};

const ISLANDS = [
  { component: "Clock", mode: "idle", prefix: "harness-clock" },
  { component: "Ticker", mode: "load", prefix: "harness-ticker" },
] as const;

// Holds every idle callback until the test releases them, so the trigger fires
// when the test says and not when Chromium happens to idle.
const HELD_IDLE = `
window.__idle = [];
window.requestIdleCallback = (callback) => { window.__idle.push(callback); return window.__idle.length; };
window.__releaseIdle = () => { for (const callback of window.__idle.splice(0)) callback(); };
`;

let build: ClientBuild;
let entry: PageEntry;
let browser: Browser;
let html: string;

beforeAll(async () => {
  if (!existsSync(RUNTIME_DIST)) {
    throw new Error(
      `Hydrated harness: "${RUNTIME_DIST}" is not there, so the page would run no islands runtime — run pnpm build first`,
    );
  }
  mkdirSync(SRC, { recursive: true });
  for (const [name, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${name}`, source);
  }
  writeFileSync(ORIGIN, "export default {};\n");

  const plan = planEntries(
    [
      {
        page: { locale: "en", path: "/", output: "/en", dependencies: [] },
        islands: ISLANDS.map(({ component, mode }) => ({ component, mode })),
      },
    ],
    { modules: { Clock: "./src/Clock.js", Ticker: "./src/Ticker.js" } },
  );
  entry = plan.entries[0] as PageEntry;
  build = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [], policy: { minSize: 0 } }),
  });

  const markers: string[] = [];
  for (const [key, island] of ISLANDS.entries()) {
    const module = (await import(`${SRC}${island.component}.js`)) as {
      default: AnyComponent;
    };
    const islandHtml = renderToString(createElement(module.default, {}), {
      identifierPrefix: island.prefix,
    });
    markers.push(
      renderToStaticMarkup(
        islandMarker(
          {
            island: { ...island, html: islandHtml },
            props: "{}",
          },
          String(key),
        ),
      ),
    );
  }
  const script = build.entryScripts.get(entry.name);
  if (script === undefined) {
    throw new Error(
      `Hydrated harness: the build emitted no entry chunk named "${entry.name}", so the page has no script to run — check the fixture still plans one entry`,
    );
  }
  html = `<!doctype html><html><head><title>hydrated harness</title></head><body>${markers.join("")}<script type="module" src="${script}"></script></body></html>`;
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser.close();
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

interface Opened {
  page: BrowserPage;
  errors: string[];
}

async function open(missing: ReadonlySet<string> = new Set()): Promise<Opened> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(HELD_IDLE);

  const byPath = new Map(build.files.map((file) => [file.path, file.contents]));
  const pathname = new URL(PAGE_URL).pathname;
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === pathname) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      return;
    }
    const contents = byPath.get(path);
    if (contents === undefined || missing.has(path)) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: `Hydrated harness: no file served at ${path}`,
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

async function hydrated(page: BrowserPage, selector: string): Promise<boolean> {
  return (await page.locator(selector).getAttribute(HYDRATED)) !== null;
}

test("the server HTML marks no island hydrated", () => {
  expect(html).toContain("<pagedeck-island");
  expect(html).not.toContain(HYDRATED);
});

test("a load island is marked once it commits; an idle island only after its trigger", async () => {
  const { page, errors } = await open();

  await expect
    .poll(() => hydrated(page, LOAD_MARKER), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate("window.__idle.length"), { timeout: 30_000 })
    .toBe(1);
  expect(await hydrated(page, IDLE_MARKER)).toBe(false);

  await page.evaluate("window.__releaseIdle()");

  await expect
    .poll(() => hydrated(page, IDLE_MARKER), { timeout: 30_000 })
    .toBe(true);
  expect(await page.locator(`pagedeck-island:not([${HYDRATED}])`).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

test("an island whose module fails to load is never marked hydrated", async () => {
  const clockChunks = build.files.filter(
    (file) =>
      file.kind === "js" &&
      String(file.contents).includes(CLOCK_TEXT),
  );
  expect(clockChunks.map((file) => file.name)).not.toContain(CORE_GROUP);
  expect(clockChunks).toHaveLength(1);
  const { page, errors } = await open(new Set(clockChunks.map((file) => file.path)));

  await expect
    .poll(() => hydrated(page, LOAD_MARKER), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate("window.__idle.length"), { timeout: 30_000 })
    .toBe(1);
  await page.evaluate("window.__releaseIdle()");

  await expect
    .poll(() => errors.some((line) => /dynamically imported module|Failed to fetch/i.test(line)), {
      timeout: 30_000,
    })
    .toBe(true);
  expect(await hydrated(page, IDLE_MARKER)).toBe(false);
  expect(await page.locator("#clock").textContent()).toBe(CLOCK_TEXT);
  await page.close();
}, 120_000);
