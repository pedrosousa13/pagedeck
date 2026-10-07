import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { budgetReportPath, readManifest, RETENTION_DIR } from "@pagedeck/core";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import type { EdgeArtifact } from "@pagedeck/edge";
import { serveBuild } from "@pagedeck/site/audit-site";
import type { ServedOrigin } from "@pagedeck/site/audit-site";
import { interpretCloudFront } from "../../adapter-cloudfront/src/interpret.test-support.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..");
const OUT = join(SITE, "site");
const LEFTOVERS = [
  OUT,
  join(SITE, "content.db"),
  join(SITE, RETENTION_DIR),
  budgetReportPath(SITE),
];
const BIN = join(SITE, "..", "core", "dist", "bin.js");

const PAGES = ["/", "/interactive", "/features", "/server-data"] as const;
const SCHEMES = ["light", "dark"] as const;
const WIDTHS = [390, 1280] as const;

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

interface Demos {
  readonly unscrolled: Readonly<Record<string, string | null>>;
  readonly scrolled: Readonly<Record<string, string | null>>;
  readonly modes: Readonly<Record<string, string | null>>;
  readonly search: {
    readonly fetchedBeforeFocus: number;
    readonly hrefs: readonly (string | null)[];
  };
  readonly consent: {
    readonly deniedState: string | null;
    readonly deniedRequests: number;
    readonly deniedLoaded: number;
    readonly grantedState: string | null;
    readonly grantedRequests: number;
    readonly loadedRequests: number;
    readonly loaded: number;
    readonly placeholders: number;
  };
  readonly image: {
    readonly current: string;
    readonly candidates: readonly string[];
    readonly natural: number;
  };
  readonly font: { readonly statuses: readonly string[]; readonly fetched: number };
  readonly social: {
    readonly href: string | null;
    readonly status: number;
    readonly type: string | undefined;
    readonly signature: readonly number[];
  };
  readonly requests: readonly string[];
  readonly violations: readonly string[];
  readonly policy: string | undefined;
  readonly csp: {
    readonly beforeConsent: readonly string[];
    readonly afterConsent: readonly string[];
    readonly afterEmbed: readonly string[];
    readonly console: readonly string[];
  };
  readonly control: {
    readonly violations: readonly string[];
    readonly console: boolean;
    readonly ran: unknown;
  };
}

interface Run {
  readonly label: string;
  readonly engine: string;
  readonly dark: boolean;
  readonly background: string;
  readonly violations: readonly string[];
  readonly passed: readonly string[];
  readonly unsettled: number;
  readonly overflow: number;
  readonly layoutWidth: number;
  readonly policy: string | undefined;
  readonly cspViolations: readonly string[];
}

let browser: Browser | undefined;
let served: ServedOrigin | undefined;
let runs: Run[] = [];
let demos: Demos | undefined;
let picker: Picker | undefined;
const offOrigin: string[] = [];
let edge: readonly EdgeArtifact[] = [];
const cspConsole: string[] = [];

const VIOLATIONS = `window.cspViolations=[];document.addEventListener("securitypolicyviolation",function(e){window.cspViolations.push(e.effectiveDirective+" "+(e.blockedURI||"inline"))})`;

const AXE_VIOLATIONS = `(async () => {
  const run = await window.axe.run(document, { resultTypes: ["violations"] });
  return run.violations.map((v) => v.id + " (" + v.impact + ", " + v.nodes.length + ")");
})()`;

beforeAll(async () => {
  for (const path of LEFTOVERS) rmSync(path, { recursive: true, force: true });
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });
  const manifest = readManifest(
    readFileSync(join(OUT, "manifest.json"), "utf8"),
    "manifest.json",
  );
  edge = cloudfront().compile(manifest.routing).artifacts;

  served = await serveBuild(OUT);
  const origin = served.origin;

  browser = await chromium.launch();
  runs = [];
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height: 844 },
        // Without `isMobile` Chromium ignores the viewport meta, so a page missing one
        // would pass at 390 px (#568, #604).
        isMobile: width === 390,
      });
      await blockOtherOrigins(context, origin);
      context.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) cspConsole.push(message.text());
      });
      const page = await context.newPage();
      for (const path of PAGES) {
        const response = await page.goto(origin + path, { waitUntil: "networkidle" });
        const policy = response?.headers()["content-security-policy"];
        await page.evaluate(AXE_SOURCE);
        const result = (await page.evaluate(`(async () => {
          const run = await window.axe.run(document, { resultTypes: ["violations", "incomplete"] });
          return {
            engine: run.testEngine.name + " " + run.testEngine.version,
            dark: matchMedia("(prefers-color-scheme: dark)").matches,
            background: getComputedStyle(document.body).backgroundColor,
            violations: run.violations.map((v) => v.id + " (" + v.impact + ", " + v.nodes.length + ")"),
            passed: run.passes.map((p) => p.id),
            unsettled: run.incomplete.filter((i) => i.id === "color-contrast").reduce((n, i) => n + i.nodes.length, 0),
            overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            layoutWidth: document.documentElement.clientWidth,
            cspViolations: window.cspViolations,
          };
        })()`)) as Omit<Run, "label" | "policy">;
        runs.push({ label: `${path} ${scheme} ${String(width)}px`, policy, ...result });
      }
      await context.close();
    }
  }
  demos = await driveDemos(browser, origin);
  picker = await drivePicker(browser, origin);
}, 240_000);

async function blockOtherOrigins(context: BrowserContext, origin: string): Promise<void> {
  await context.addInitScript({ content: VIOLATIONS });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) {
      offOrigin.push(url);
      return route.abort("blockedbyclient");
    }
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: { ...response.headers(), ...(await edgeHeaders(url)) },
    });
  });
}

async function edgeHeaders(url: string): Promise<Record<string, string>> {
  const resolution = await interpretCloudFront(edge, {
    path: new URL(url).pathname,
    found: true,
  });
  if (resolution.kind !== "pass") return {};
  return Object.fromEntries(resolution.headers.map(({ name, value }) => [name, value]));
}

// Polled with `page.evaluate`, not `page.waitForFunction`, which evaluates with
// the page's own `eval` and so is refused by the site's policy.
async function until(page: Page, expression: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await page.evaluate(expression))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expression}`);
    await page.waitForTimeout(50);
  }
}

function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate("window.cspViolations") as Promise<string[]>;
}

function hydrated(probe: string): string {
  return `document.querySelector('[data-probe="${probe}"]')?.getAttribute("data-hydrated") === "true"`;
}

async function probes(page: Page): Promise<Record<string, string | null>> {
  // A string: this package's tsconfig carries no DOM lib.
  return (await page.evaluate(`Object.fromEntries(
    [...document.querySelectorAll("[data-probe]")].map((probe) => [
      probe.getAttribute("data-probe"),
      probe.getAttribute("data-hydrated"),
    ]),
  )`)) as Record<string, string | null>;
}

async function driveDemos(browser: Browser, origin: string): Promise<Demos> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await blockOtherOrigins(context, origin);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const reports: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) reports.push(message.text());
  });
  const count = (pattern: RegExp) => requests.filter((url) => pattern.test(new URL(url).pathname)).length;

  const navigation = await page.goto(`${origin}/features#i18n`, { waitUntil: "networkidle" });
  const policy = navigation?.headers()["content-security-policy"];

  // Half a second more, so a `visible` that was merely slow is not read as one
  // that was waiting.
  await until(page, hydrated("idle"));
  await page.waitForTimeout(500);
  const unscrolled = await probes(page);
  await page.locator('[data-probe="visible"]').scrollIntoViewIfNeeded();
  await until(page, hydrated("visible"));
  await page.waitForTimeout(250);
  const scrolled = await probes(page);
  const modes = (await page.evaluate(`Object.fromEntries(
    [...document.querySelectorAll("[data-probe]")].map((probe) => [
      probe.getAttribute("data-probe"),
      probe.closest("[data-fw-component]")?.getAttribute("data-fw-mode") ?? null,
    ]),
  )`)) as Record<string, string | null>;

  const fetchedBeforeFocus = count(/^\/search\//);
  const input = page.getByRole("combobox", { name: "Search this site" });
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await input.pressSequentially("island");
  await page.getByRole("option").first().waitFor();
  const hrefs = await Promise.all(
    (await page.getByRole("option").all()).map((option) => option.getAttribute("href")),
  );

  const facade = page.locator("[data-fw-facade]");
  const embed = /^\/embed\/demo-embed\.js$/;
  await page.locator(".fw-embed__load").click();
  await page.waitForTimeout(500);
  const deniedState = await facade.getAttribute("data-fw-consent");
  const deniedRequests = count(embed);
  const deniedLoaded = await page.locator('[data-embed="loaded"]').count();
  const beforeConsent = await cspViolations(page);
  // The banner hydrates on `visible`, so early presses can land on its server
  // HTML; press until it settles.
  const accept = page.locator(".consent-banner__accept");
  for (let tries = 0; tries < 40; tries += 1) {
    if ((await page.locator(".consent-banner--settled").count()) > 0) break;
    if ((await accept.count()) > 0) await accept.click();
    await page.waitForTimeout(250);
  }
  const grantedState = await facade.getAttribute("data-fw-consent");
  await page.waitForTimeout(250);
  const grantedRequests = count(embed);
  const afterConsent = await cspViolations(page);
  await page.locator(".fw-embed__load").click();
  await page.locator('[data-embed="loaded"]').waitFor();
  const afterEmbed = await cspViolations(page);
  const consent = {
    deniedState,
    deniedRequests,
    deniedLoaded,
    grantedState,
    grantedRequests,
    loadedRequests: count(embed),
    loaded: await page.locator('[data-embed="loaded"]').count(),
    placeholders: await page.locator("[data-fw-facade]").count(),
  };

  // Scoped to `#images`: the social card section has a `.fw-figure` too (#619).
  const img = page.locator("#images .fw-figure__img");
  await img.scrollIntoViewIfNeeded();
  const IMG = `document.querySelector("#images .fw-figure__img")`;
  await until(page, `${IMG}.complete && ${IMG}.naturalWidth > 0`);
  const image = (await page.evaluate(`({
    current: new URL(${IMG}.currentSrc).pathname,
    candidates: ${IMG}.srcset.split(",").map((entry) => entry.trim().split(/\\s+/)[0]),
    natural: ${IMG}.naturalWidth,
  })`)) as Demos["image"];

  await page.locator(".fw-specimen").scrollIntoViewIfNeeded();
  const statuses = (await page.evaluate(`document.fonts.ready.then(() =>
    [...document.fonts]
      .filter((face) => face.family.replace(/"/g, "") === "Fira Sans")
      .map((face) => face.status))`)) as string[];
  const font = { statuses, fetched: count(/^\/fonts\/.+\.woff2$/) };

  const href = await page.locator('meta[property="og:image"]').getAttribute("content");
  const response = await context.request.get(`${origin}${href ?? "/missing"}`);
  const body = await response.body();
  const social = {
    href,
    status: response.status(),
    type: response.headers()["content-type"],
    signature: [...body.subarray(0, 8)],
  };

  await page.evaluate(AXE_SOURCE);
  const violations = (await page.evaluate(AXE_VIOLATIONS)) as string[];
  const csp = { beforeConsent, afterConsent, afterEmbed, console: [...reports] };

  await page.evaluate(
    "document.head.appendChild(document.createElement('script')).textContent='window.injected=1'",
  );
  await until(page, "window.cspViolations.length > 0");
  const deadline = Date.now() + 10_000;
  while (reports.length === csp.console.length && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }
  const control = {
    violations: await cspViolations(page),
    console: reports.length > csp.console.length,
    ran: await page.evaluate("window.injected"),
  };

  await context.close();
  return {
    unscrolled,
    scrolled,
    modes,
    search: { fetchedBeforeFocus, hrefs },
    consent,
    image,
    font,
    social,
    requests,
    violations,
    policy,
    csp,
    control,
  };
}

interface Picker {
  readonly mode: string | null;
  readonly before: string;
  readonly after: string;
  readonly violations: readonly string[];
  readonly csp: readonly string[];
}

// Waits for React's `__reactFiber` key on the form: pressed before hydration,
// the button submits the form natively and reloads the page.
async function drivePicker(browser: Browser, origin: string): Promise<Picker> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await blockOtherOrigins(context, origin);
  const page = await context.newPage();
  await page.goto(`${origin}/server-data`, { waitUntil: "networkidle" });
  const form = page.locator(".fw-picker form");
  const output = form.locator("output");
  const before = (await output.textContent()) ?? "";
  await form.scrollIntoViewIfNeeded();
  await until(
    page,
    `Object.keys(document.querySelector(".fw-picker form")).some((key) => key.startsWith("__reactFiber"))`,
  );
  await page.getByRole("radio", { name: "Moss" }).check();
  await page.getByRole("radio", { name: "L", exact: true }).check();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await until(page, `document.querySelector(".fw-picker output").textContent.startsWith("1 ")`);
  const after = (await output.textContent()) ?? "";
  const mode = await page.locator('[data-fw-component="variant_picker"]').getAttribute("data-fw-mode");
  await page.evaluate(AXE_SOURCE);
  const violations = (await page.evaluate(AXE_VIOLATIONS)) as string[];
  const csp = await cspViolations(page);
  await context.close();
  return { mode, before, after, violations, csp };
}

afterAll(async () => {
  await browser?.close();
  await served?.close();
  for (const path of LEFTOVERS) rmSync(path, { recursive: true, force: true });
});

test("every page, in both schemes and at both widths, has no axe violation", () => {
  expect(runs).toHaveLength(PAGES.length * SCHEMES.length * WIDTHS.length);
  const faults = runs.flatMap((run) =>
    run.violations.map((violation) => `  ${run.label}: ${violation}`),
  );
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("no page scrolls sideways on a 390 px phone, in either scheme", () => {
  const phone = runs.filter((run) => run.label.endsWith(" 390px"));
  expect(phone).toHaveLength(PAGES.length * SCHEMES.length);
  expect(
    phone.filter((run) => run.layoutWidth !== 390).map((run) => `${run.label}: ${String(run.layoutWidth)}px`),
  ).toEqual([]);
  expect(
    phone.filter((run) => run.overflow > 0).map((run) => `${run.label}: ${String(run.overflow)}px`),
  ).toEqual([]);
});

test("every page was served with the site's policy, and reported no violation of it (#577)", () => {
  expect(runs).toHaveLength(PAGES.length * SCHEMES.length * WIDTHS.length);
  expect(runs.filter((run) => run.policy !== CONTENT_SECURITY_POLICY).map((run) => run.label)).toEqual([]);
  expect(runs.flatMap((run) => run.cspViolations.map((violation) => `${run.label}: ${violation}`))).toEqual([]);
  expect(cspConsole).toEqual([]);
});

test("the dark runs really were dark, and contrast was measured in every run", () => {
  for (const run of runs) {
    expect(run.dark, run.label).toBe(run.label.includes(" dark "));
    expect(run.engine, run.label).toMatch(/^axe-core \d+\./);
    expect(run.passed, run.label).toContain("color-contrast");
  }
  const light = runs.find((run) => run.label.startsWith("/ light"));
  const dark = runs.find((run) => run.label.startsWith("/ dark"));
  expect(light?.background).not.toBe(dark?.background);

  process.stdout.write(
    [
      "",
      "color-contrast nodes axe could not settle, reported and not asserted:",
      ...runs.map((run) => `  ${run.label}: ${String(run.unsettled)}`),
      "",
    ].join("\n"),
  );
});

describe("/features, driven in the browser (#551)", () => {
  const seen = (): Demos => {
    if (demos === undefined) throw new Error("the demos were not driven");
    return demos;
  };

  test("each island hydrates under its own strategy, and the static twin never does", () => {
    const { unscrolled, scrolled, modes } = seen();
    expect(modes).toEqual({ load: "load", idle: "idle", visible: "visible", static: null });
    expect(unscrolled).toEqual({ load: "true", idle: "true", visible: "false", static: "false" });
    expect(scrolled).toEqual({ load: "true", idle: "true", visible: "true", static: "false" });
  });

  test("the search box fetches nothing before focus, and a query returns a result", () => {
    const { search } = seen();
    expect(search.fetchedBeforeFocus).toBe(0);
    expect(search.hrefs).toContain("/interactive/");
  });

  test("the embed stays unloaded until consent, and loads after it", () => {
    const { consent } = seen();
    expect(consent.deniedState).toBe("denied");
    expect(consent.deniedRequests).toBe(0);
    expect(consent.deniedLoaded).toBe(0);
    expect(consent.grantedState).toBe("granted");
    expect(consent.grantedRequests).toBe(0);
    expect(consent.loadedRequests).toBe(1);
    expect(consent.loaded).toBe(1);
    expect(consent.placeholders).toBe(0);
  });

  test("the responsive image picks one of its candidates and loads it", () => {
    const { image } = seen();
    expect(image.candidates.length).toBeGreaterThanOrEqual(3);
    expect(image.candidates).toContain(image.current);
    expect(image.natural).toBeGreaterThan(0);
  });

  test("the specimen's subset face is fetched from this site and loaded", () => {
    const { font } = seen();
    expect(font.fetched).toBe(1);
    expect(font.statuses).toContain("loaded");
  });

  test("the social card the head names is served, as a PNG", () => {
    const { social } = seen();
    expect(social.href).toMatch(/^\/social\/.+\.png$/);
    expect(social.status).toBe(200);
    expect(social.type).toBe("image/png");
    expect(social.signature).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("the page as the demos left it has no axe violation", () => {
    expect(seen().violations).toEqual([]);
  });

  test("the page runs under the site's policy with no violation before consent, after it, or after the embed loads (#577)", () => {
    const { policy, csp } = seen();
    expect(policy).toBe(CONTENT_SECURITY_POLICY);
    expect(csp.beforeConsent).toEqual([]);
    expect(csp.afterConsent).toEqual([]);
    expect(csp.afterEmbed).toEqual([]);
    expect(csp.console).toEqual([]);
  });

  test("an inline script the policy does not list is reported and does not run (#577)", () => {
    const { control } = seen();
    expect(control.violations).toEqual(["script-src-elem inline"]);
    expect(control.console).toBe(true);
    expect(control.ran).toBeUndefined();
  });

  test("no request left the origin, before consent or after, from any page", () => {
    expect(offOrigin).toEqual([]);
    const requests = seen().requests;
    expect(requests.length).toBeGreaterThan(0);
    const origin = new URL(requests[0] as string).origin;
    expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  });
});

describe("/server-data, driven in the browser (#625)", () => {
  const seen = (): Picker => {
    if (picker === undefined) throw new Error("the picker was not driven");
    return picker;
  };

  test("the variant picker, rendered from a server component's code, hydrates and adds the chosen variant", () => {
    const { mode, before, after } = seen();
    expect(mode).toBe("visible");
    expect(before).toBe("Your cart is empty.");
    expect(after).toBe("1 in your cart, last RSH-24-MOS-L.");
  });

  test("the page as the picker left it has no axe violation and no policy violation", () => {
    const { violations, csp } = seen();
    expect(violations).toEqual([]);
    expect(csp).toEqual([]);
  });
});
