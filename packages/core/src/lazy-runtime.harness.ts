// Opt-in: `pnpm build && pnpm test:lazy-runtime-harness`. Chromium, because jsdom
// ignores `<script type="module">` and makes no requests; `@pagedeck/islands`
// runs out of `dist`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser } from "playwright";
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
  new URL("../node_modules/.pagedeck-lazy-runtime-harness/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const STARTUP_DIST = fileURLToPath(
  new URL("../../islands/dist/startup.js", import.meta.url),
);

const PREFIX = "harness-clock";
const PAGE_URL = "https://lazy-runtime.harness.invalid/en/";

const CLOCK = `import { createElement, useEffect, useState } from "react";
export default function Clock() {
  const [state, setState] = useState("server");
  useEffect(() => { setState("hydrated"); }, []);
  return createElement("p", { id: "clock" }, state);
}
`;

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
let clockHtml: string;

beforeAll(async () => {
  if (!existsSync(STARTUP_DIST)) {
    throw new Error(
      `Lazy runtime harness: "${STARTUP_DIST}" is not there, so the emitted entry would import no startup module — run pnpm build first`,
    );
  }
  mkdirSync(SRC, { recursive: true });
  writeFileSync(`${SRC}Clock.js`, CLOCK);
  writeFileSync(ORIGIN, "export default {};\n");

  const plan = planEntries(
    [
      {
        page: { locale: "en", path: "/", output: "/en", dependencies: [] },
        islands: [{ component: "Clock", mode: "idle" }],
      },
    ],
    { modules: { Clock: "./src/Clock.js" } },
  );
  entry = plan.entries[0] as PageEntry;
  build = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [], policy: { minSize: 0 } }),
  });

  const clock = (await import(`${SRC}Clock.js`)) as { default: AnyComponent };
  clockHtml = renderToString(createElement(clock.default, {}), {
    identifierPrefix: PREFIX,
  });
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser.close();
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function pageHtml(): string {
  const script = build.entryScripts.get(entry.name);
  if (script === undefined) {
    throw new Error(
      `Lazy runtime harness: the build emitted no entry chunk named "${entry.name}", so the page has no script to run — check the fixture still plans one entry`,
    );
  }
  const marker = renderToStaticMarkup(
    islandMarker(
      {
        island: { component: "Clock", mode: "idle", prefix: PREFIX, html: clockHtml },
        props: "{}",
      },
      "0",
    ),
  );
  return `<!doctype html><html><head><title>lazy runtime harness</title></head><body>${marker}<script type="module" src="${script}"></script></body></html>`;
}

test("an all-idle page requests no core chunk before the idle trigger, and hydrates after it", async () => {
  const core = build.files.find(
    (file) => file.kind === "js" && file.name === CORE_GROUP,
  );
  expect(core).toBeDefined();

  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  const requested: string[] = [];
  page.on("request", (request) => {
    requested.push(new URL(request.url()).pathname);
  });
  await page.addInitScript(HELD_IDLE);

  const html = pageHtml();
  const byPath = new Map(build.files.map((file) => [file.path, file.contents]));
  const pathname = new URL(PAGE_URL).pathname;
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === pathname) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      return;
    }
    const contents = byPath.get(path);
    if (contents === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: `Lazy runtime harness: no emitted file at ${path}`,
      });
      return;
    }
    await route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: typeof contents === "string" ? contents : Buffer.from(contents),
    });
  });

  await page.goto(PAGE_URL);
  // The module graph has run once the startup module has asked for idle time.
  await expect
    .poll(() => page.evaluate("window.__idle.length"), { timeout: 30_000 })
    .toBe(1);

  expect(requested).toContain(build.entryScripts.get(entry.name));
  expect(requested).not.toContain(core?.path);
  expect(await page.locator("#clock").textContent()).toBe("server");

  await page.evaluate("window.__releaseIdle()");

  await expect
    .poll(() => page.locator("#clock").textContent(), { timeout: 30_000 })
    .toBe("hydrated");
  expect(requested).toContain(core?.path);
  expect(errors).toEqual([]);
  await page.close();
}, 120_000);
