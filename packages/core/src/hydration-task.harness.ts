// Opt-in: `pnpm build && pnpm test:hydration-task-harness`. Chromium, because
// jsdom has no tasks to measure; `@pagedeck/islands` runs out of `dist`.
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
import { planTiers } from "./tiers.js";
import { islandMarker } from "./tree.js";
import type { AnyComponent } from "./tree.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-hydration-task-harness/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const RUNTIME_DIST = fileURLToPath(
  new URL("../../islands/dist/runtime.js", import.meta.url),
);

const PREFIX = "harness-big";
const PAGE_URL = "https://hydration-task.harness.invalid/en/";
const CPU_SLOWDOWN = 4;
const RUNS = 3;

const BIG = `import { createElement, useEffect, useState } from "react";
function Row({ index }) {
  return createElement("li", null, createElement("span", null, "row "), createElement("b", null, String(index)));
}
function Group({ group }) {
  return createElement("ul", null, Array.from({ length: 100 }, (_, index) => createElement(Row, { key: index, index: group * 100 + index })));
}
let started = false;
export default function Big() {
  if (!started) { started = true; performance.mark("hydrate-start"); }
  const [state, setState] = useState("server");
  useEffect(() => { performance.mark("hydrate-end"); setState("hydrated"); }, []);
  return createElement("div", null,
    createElement("p", { id: "state" }, state),
    Array.from({ length: 50 }, (_, group) => createElement(Group, { key: group, group })));
}
`;

let build: ClientBuild;
let entry: PageEntry;
let browser: Browser;
let bigHtml: string;

beforeAll(async () => {
  if (!existsSync(RUNTIME_DIST)) {
    throw new Error(
      `Hydration task harness: "${RUNTIME_DIST}" is not there, so the page would hydrate with no islands runtime — run pnpm build first`,
    );
  }
  mkdirSync(SRC, { recursive: true });
  writeFileSync(`${SRC}Big.js`, BIG);
  writeFileSync(ORIGIN, "export default {};\n");

  const plan = planEntries(
    [
      {
        page: { locale: "en", path: "/", output: "/en", dependencies: [] },
        islands: [{ component: "Big", mode: "load" }],
      },
    ],
    { modules: { Big: "./src/Big.js" } },
  );
  entry = plan.entries[0] as PageEntry;
  build = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [], policy: { minSize: 0 } }),
  });

  const big = (await import(`${SRC}Big.js`)) as { default: AnyComponent };
  bigHtml = renderToString(createElement(big.default, {}), {
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
      `Hydration task harness: the build emitted no entry chunk named "${entry.name}", so the page has no script to run — check the fixture still plans one entry`,
    );
  }
  const marker = renderToStaticMarkup(
    islandMarker(
      {
        island: { component: "Big", mode: "load", prefix: PREFIX, html: bigHtml },
        props: "{}",
      },
      "0",
    ),
  );
  return `<!doctype html><html><head><title>hydration task harness</title></head><body>${marker}<script type="module" src="${script}"></script></body></html>`;
}

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
}

interface Hydration {
  // From the island's first render to its first passive effect.
  spanMs: number;
  longestTaskMs: number;
}

function measureHydration(events: readonly TraceEvent[]): Hydration {
  const start = events.find((event) => event.name === "hydrate-start");
  const end = events.find((event) => event.name === "hydrate-end");
  if (start === undefined || end === undefined) {
    throw new Error(
      "Hydration task harness: the trace holds no hydrate-start or hydrate-end mark, so there is no hydration span to measure — check the fixture island still marks both",
    );
  }
  let longest = 0;
  for (const event of events) {
    if (
      event.name !== "ThreadControllerImpl::RunTask" ||
      event.ph !== "X" ||
      event.pid !== start.pid ||
      event.tid !== start.tid ||
      event.dur === undefined
    ) {
      continue;
    }
    if (event.ts < end.ts && event.ts + event.dur > start.ts) {
      longest = Math.max(longest, event.dur / 1000);
    }
  }
  return { spanMs: (end.ts - start.ts) / 1000, longestTaskMs: longest };
}

async function measureOnce(): Promise<Hydration> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
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
        body: `Hydration task harness: no emitted file at ${path}`,
      });
      return;
    }
    await route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: typeof contents === "string" ? contents : Buffer.from(contents),
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  await browser.startTracing(page, {
    categories: ["toplevel", "blink.user_timing"],
  });
  await page.goto(PAGE_URL);
  await expect
    .poll(() => page.locator("#state").textContent(), { timeout: 60_000 })
    .toBe("hydrated");
  const trace = JSON.parse((await browser.stopTracing()).toString()) as {
    traceEvents: TraceEvent[];
  };
  expect(errors).toEqual([]);
  await page.close();
  return measureHydration(trace.traceEvents);
}

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
}

// One task would hold the whole span; half is the line a sliced hydration
// stays well under and an unsliced one never does.
test(`a 5000-row load island hydrates at ${String(CPU_SLOWDOWN)}x CPU slowdown in tasks each shorter than half the hydration`, async () => {
  const runs: Hydration[] = [];
  for (let run = 0; run < RUNS; run += 1) runs.push(await measureOnce());
  const longest = median(runs.map((run) => run.longestTaskMs));
  const span = median(runs.map((run) => run.spanMs));
  console.log(
    `longest task during hydration: ${runs.map((run) => run.longestTaskMs.toFixed(1)).join(", ")} ms, median ${longest.toFixed(1)} ms; hydration span median ${span.toFixed(1)} ms`,
  );

  expect(longest).toBeLessThan(span / 2);
}, 180_000);
