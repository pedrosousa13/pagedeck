import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { ComponentType } from "react";
import ConsentBanner from "@pagedeck/design-system/components/consent_banner";
import LandingPage from "@pagedeck/design-system/components/landing_page";
import { axeVerdict } from "./audit.js";
import type { AxePageResult } from "./audit.js";
import { AUDIT_URLS, buildAuditSite, serveBuild } from "./audit-site.js";
import type { ServedOrigin } from "./audit-site.js";
import { DRAFT_ENTRIES } from "./content.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const SITE = join(import.meta.dirname, "..", ".pagedeck-a11y-harness");

const SCHEMES = ["light", "dark"] as const;
const WIDTHS = [390, 1280] as const;
const BANNERS = ["none", "open", "settled"] as const;
type BannerState = (typeof BANNERS)[number];
const SHORT_PHONE = { width: 390, height: 600 } as const;

const BANNER_COPY = {
  en: {
    heading: "Cookies on this site",
    body: "We would like to measure how the site is used, and to remember your settings. You can change your answer at any time.",
    acceptLabel: "Accept all",
    rejectLabel: "Reject all",
    manageLabel: "Cookie settings",
  },
  de: {
    heading: "Cookies auf dieser Seite",
    body: "Wir möchten messen, wie die Seite genutzt wird, und Ihre Einstellungen speichern. Sie können Ihre Antwort jederzeit ändern.",
    acceptLabel: "Alle akzeptieren",
    rejectLabel: "Alle ablehnen",
    manageLabel: "Cookie-Einstellungen",
  },
} as const;
type Locale = keyof typeof BANNER_COPY;

// Declared here: axe-core's types reference `lib.dom` (#289).
interface Run {
  readonly url: string;
  readonly scheme: (typeof SCHEMES)[number];
  readonly width: (typeof WIDTHS)[number];
  readonly banner: BannerState;
  readonly engine: string;
  readonly violations: AxePageResult["violations"];
  readonly described: readonly string[];
  readonly passed: readonly string[];
  readonly dark: boolean;
  readonly background: string;
  readonly overflow: number;
  readonly layoutWidth: number;
  readonly bannerPosition: string | null;
  readonly bannerInView: boolean;
}

interface Walk {
  readonly label: string;
  readonly stops: number;
  readonly obscured: readonly string[];
  readonly layoutWidth: number;
}

function label(run: Run): string {
  return `${run.url} ${run.scheme} ${String(run.width)}px banner:${run.banner}`;
}

let browser: Browser | undefined;
let served: ServedOrigin | undefined;
let runs: Run[] = [];
let walks: Walk[] = [];
let landingRuns: Run[] = [];

// Declared here: `@types/jsdom` references `lib.dom` (#289).
interface RenderWindow {
  document: {
    getElementById(id: string): RenderElement | null;
  };
  dispatchEvent(event: unknown): boolean;
  Event: unknown;
  close(): void;
}
interface RenderElement {
  innerHTML: string;
  querySelector(selector: string): { click(): void } | null;
}

// jsdom's globals go on `globalThis` before `react-dom/client` is first imported:
// it decides at load whether it has a DOM.
async function pressedMarkup(
  element: ReturnType<typeof createElement>,
  selector: string,
): Promise<string> {
  const view = new JSDOM('<!doctype html><body><div id="root"></div></body>')
    .window as unknown as RenderWindow;
  const scope = globalThis as unknown as Record<string, unknown>;
  const installed: Record<string, unknown> = {
    window: view,
    document: view.document,
    dispatchEvent: view.dispatchEvent.bind(view),
    Event: view.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(installed).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(installed)) {
    Object.defineProperty(scope, key, { value, configurable: true, writable: true });
  }
  try {
    const { createRoot } = await import("react-dom/client");
    const container = view.document.getElementById("root") as RenderElement;
    const root = createRoot(container as unknown as Parameters<typeof createRoot>[0]);
    await act(async () => {
      root.render(element);
    });
    await act(async () => {
      container.querySelector(selector)?.click();
    });
    const markup = container.innerHTML;
    await act(async () => {
      root.unmount();
    });
    // jsdom queues events after a focus move and React listens on the document;
    // closing the window drops them before React's globals go.
    view.close();
    return markup;
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(scope, key);
      else Object.defineProperty(scope, key, descriptor);
    }
  }
}

async function bannerMarkup(): Promise<Record<Locale, Record<Exclude<BannerState, "none">, string>>> {
  const out = {} as Record<Locale, Record<Exclude<BannerState, "none">, string>>;
  for (const locale of Object.keys(BANNER_COPY) as Locale[]) {
    const copy = BANNER_COPY[locale];
    out[locale] = {
      open: renderToStaticMarkup(createElement(ConsentBanner, copy)),
      settled: await pressedMarkup(
        createElement(ConsentBanner, copy),
        ".consent-banner__accept",
      ),
    };
  }
  return out;
}

const LANDING_HOST = "/en/legal/terms";

async function landingMarkup(): Promise<string> {
  const careers = DRAFT_ENTRIES.find(
    (entry) => entry.locale === "en" && entry.path === "careers",
  )?.data;
  if (careers?.mode !== "template" || careers.template !== "landing_page") {
    throw new Error(
      "A11y harness: the draft entries hold no en/careers landing_page entry, so there is no landing template to audit — restore it in DRAFT_ENTRIES in packages/site/src/content.ts",
    );
  }
  return pressedMarkup(
    createElement(LandingPage as ComponentType<Record<string, unknown>>, {
      ...careers,
    }),
    ".landing > button",
  );
}
async function load(
  page: Page,
  url: string,
  banner: BannerState,
  banners: Awaited<ReturnType<typeof bannerMarkup>>,
): Promise<void> {
  // `networkidle`, not `load`: the island's module graph runs after `load`, and an
  // audit before hydration audits a page no reader sees.
  await page.goto((served as ServedOrigin).origin + url, { waitUntil: "networkidle" });
  if (banner === "none") return;
  const markup = banners[url.split("/")[1] as Locale][banner];
  await page.evaluate(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(markup)})`);
}

async function audit(page: Page): Promise<Omit<Run, "url" | "scheme" | "width" | "banner">> {
  await page.evaluate(AXE_SOURCE);
  return (await page.evaluate(`(async () => {
    const run = await window.axe.run(document, { resultTypes: ["violations"] });
    const banner = document.querySelector(".consent-banner");
    const box = banner === null ? null : banner.getBoundingClientRect();
    return {
      engine: run.testEngine.name + " " + run.testEngine.version,
      violations: run.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      described: run.violations.map((v) => v.id + " (" + v.impact + ", " + v.nodes.length + "): " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")),
      passed: run.passes.map((p) => p.id),
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      background: getComputedStyle(document.body).backgroundColor,
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      layoutWidth: document.documentElement.clientWidth,
      bannerPosition: banner === null ? null : getComputedStyle(banner).position,
      bannerInView: banner !== null && banner.checkVisibility() && box.bottom <= innerHeight && box.top >= 0,
    };
  })()`)) as Omit<Run, "url" | "scheme" | "width" | "banner">;
}

async function walk(page: Page, walkLabel: string): Promise<Walk> {
  const seen = new Set<string>();
  const obscured: string[] = [];
  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Tab");
    const at = (await page.evaluate(`(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const banner = document.querySelector(".consent-banner");
      const a = el.getBoundingClientRect();
      const b = banner.getBoundingClientRect();
      const hit = !banner.contains(el) && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
      return { key: el.tagName.toLowerCase() + " " + JSON.stringify((el.textContent || "").trim().slice(0, 40)), hit };
    })()`)) as { key: string; hit: boolean } | null;
    if (at === null || seen.has(at.key)) break;
    seen.add(at.key);
    if (at.hit) obscured.push(at.key);
  }
  const layoutWidth = (await page.evaluate("document.documentElement.clientWidth")) as number;
  return { label: walkLabel, stops: seen.size, obscured, layoutWidth };
}

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  const banners = await bannerMarkup();
  const landing = await landingMarkup();
  const out = await buildAuditSite(SITE);
  served = await serveBuild(out);
  browser = await chromium.launch();
  runs = [];
  walks = [];
  landingRuns = [];
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height: 844 },
        // A phone as a phone: without `isMobile` Chromium ignores the
        // viewport meta, so a page missing one would pass at 390 px (#568).
        isMobile: width === 390,
      });
      const page = await context.newPage();
      for (const banner of BANNERS) {
        for (const url of AUDIT_URLS) {
          await load(page, url, banner, banners);
          runs.push({ url, scheme, width, banner, ...(await audit(page)) });
        }
      }
      await load(page, LANDING_HOST, "none", banners);
      const replaced = (await page.evaluate(`(() => {
        const host = document.querySelector(".legal");
        if (host === null) return false;
        host.outerHTML = ${JSON.stringify(landing)};
        return true;
      })()`)) as boolean;
      if (!replaced) {
        throw new Error(
          `A11y harness: page "${LANDING_HOST}" holds no ".legal" element, so there is no template to replace with the landing template's markup — point LANDING_HOST at a page the legal template renders, or change the selector to that page's template root`,
        );
      }
      landingRuns.push({
        url: `${LANDING_HOST} (landing_page)`,
        scheme,
        width,
        banner: "none",
        ...(await audit(page)),
      });
      await context.close();
    }
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: SHORT_PHONE,
      isMobile: true,
    });
    const page = await context.newPage();
    for (const url of AUDIT_URLS) {
      await load(page, url, "open", banners);
      walks.push(await walk(page, `${url} ${scheme} ${String(SHORT_PHONE.width)}x${String(SHORT_PHONE.height)}`));
    }
    await context.close();
  }
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await served?.close();
  rmSync(SITE, { recursive: true, force: true });
});

function layouts(): Run[][] {
  const grouped = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${run.scheme} ${String(run.width)} ${run.banner}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return [...grouped.values()];
}

test("no page of the representative set has a serious or critical violation, in any layout", () => {
  const all = layouts();
  expect(all).toHaveLength(SCHEMES.length * WIDTHS.length * BANNERS.length);
  for (const layout of all) {
    const verdict = axeVerdict({ urls: AUDIT_URLS, results: layout });
    expect(verdict.pages).toBe(4);
    expect(verdict.blocking).toEqual([]);
  }
});

test("no page has an axe violation of any impact, in either scheme, at either width, in any banner state", () => {
  const faults = runs.flatMap((run) => run.described.map((line) => `  ${label(run)}: ${line}`));
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("the landing template, form open, has no axe violation, in either scheme, at either width", () => {
  // `label` in `passed` shows the injection took: axe passes the rule only when it
  // found a form control to check.
  expect(landingRuns).toHaveLength(SCHEMES.length * WIDTHS.length);
  for (const run of landingRuns) {
    expect(run.engine, label(run)).toMatch(/^axe-core \d+\./);
    expect(run.passed, label(run)).toContain("label");
    expect(run.dark, label(run)).toBe(run.scheme === "dark");
    if (run.width === 390) expect(run.overflow, label(run)).toBe(0);
  }
  const faults = landingRuns.flatMap((run) => run.described.map((line) => `  ${label(run)}: ${line}`));
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("no page scrolls sideways on a 390 px phone, in either scheme, in any banner state", () => {
  const phone = runs.filter((run) => run.width === 390);
  expect(phone).toHaveLength(AUDIT_URLS.length * SCHEMES.length * BANNERS.length);
  // Laid out at the phone's width, so the viewport meta took (#568): a page without
  // one lays out at 980 px and cannot scroll sideways at 390.
  expect(walks).toHaveLength(AUDIT_URLS.length * SCHEMES.length);
  expect([
    ...phone.filter((run) => run.layoutWidth !== 390).map((run) => `${label(run)}: ${String(run.layoutWidth)}px`),
    ...walks.filter((one) => one.layoutWidth !== 390).map((one) => `${one.label}: ${String(one.layoutWidth)}px`),
  ]).toEqual([]);
  expect(
    phone.filter((run) => run.overflow > 0).map((run) => `${label(run)}: ${String(run.overflow)}px`),
  ).toEqual([]);
});

test("the open banner is sticky and in view, and the settled one sits in the page's flow", () => {
  for (const run of runs) {
    const expected = { none: null, open: "sticky", settled: "static" }[run.banner];
    expect(run.bannerPosition, label(run)).toBe(expected);
    if (run.banner === "open") expect(run.bannerInView, label(run)).toBe(true);
  }
});

test("no focused element is hidden behind the open banner", () => {
  expect(walks).toHaveLength(AUDIT_URLS.length * SCHEMES.length);
  for (const one of walks) {
    expect(one.stops, one.label).toBeGreaterThanOrEqual(2);
  }
  expect(walks.flatMap((one) => one.obscured.map((key) => `  ${one.label}: ${key}`))).toEqual([]);
});

test("axe ran on every page, the dark runs were dark, and contrast was measured in every run", () => {
  // Guards against a clean verdict because nothing looked, or because the dark
  // emulation did not take.
  for (const run of runs) {
    expect(run.engine, label(run)).toMatch(/^axe-core \d+\./);
    expect(run.dark, label(run)).toBe(run.scheme === "dark");
    expect(run.passed, label(run)).toContain("color-contrast");
  }
  const light = runs.find((run) => run.scheme === "light");
  const dark = runs.find((run) => run.scheme === "dark");
  expect(light?.background).not.toBe(dark?.background);
});
