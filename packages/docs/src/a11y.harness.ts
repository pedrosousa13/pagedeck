import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { budgetReportPath, RETENTION_DIR } from "@pagedeck/core";
import { serveBuild } from "@pagedeck/site/audit-site";
import type { ServedOrigin } from "@pagedeck/site/audit-site";
import { interpretCloudflarePages } from "../../adapter-cloudflare-pages/src/interpret.test-support.js";
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

const PAGES = [
  "/",
  "/tutorials/your-first-site",
  "/how-to/write-a-loader",
  "/how-to/add-an-island",
  "/how-to/connect-a-cms",
  "/how-to/deploy-a-site",
  "/reference/images",
  "/search",
] as const;
const QUERY = { text: "loader", finds: "/how-to/write-a-loader/" } as const;
const SCHEMES = ["light", "dark"] as const;
const WIDTHS = [390, 1280] as const;

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

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
  readonly navShown: boolean;
  readonly policy: string | undefined;
  readonly cspViolations: readonly string[];
}

let browser: Browser | undefined;
let served: ServedOrigin | undefined;
let runs: Run[] = [];
let unfolded: boolean[] = [];
let written: { role: "tree-file"; path: string; contents: string }[] = [];

const VIOLATIONS = `window.cspViolations=[];document.addEventListener("securitypolicyviolation",function(e){window.cspViolations.push(e.effectiveDirective+" "+(e.blockedURI||"inline"))})`;

async function serveWrittenHeaders(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: VIOLATIONS });
  await context.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const resolution = interpretCloudflarePages(written, {
      path: new URL(route.request().url()).pathname,
      found: true,
    });
    const headers = resolution.kind === "pass" ? resolution.headers : [];
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        ...Object.fromEntries(headers.map(({ name, value }) => [name, value])),
      },
    });
  });
}

async function visit(page: Page, url: string): Promise<string | undefined> {
  const response = await page.goto(url, { waitUntil: "networkidle" });
  return response?.headers()["content-security-policy"];
}

async function audit(page: Page, label: string, policy: string | undefined): Promise<Run> {
  await page.evaluate(AXE_SOURCE);
  const result = (await page.evaluate(`(async () => {
    const run = await window.axe.run(document, { resultTypes: ["violations", "incomplete"] });
    const link = document.querySelector(".fw-docnav a");
    return {
      engine: run.testEngine.name + " " + run.testEngine.version,
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      background: getComputedStyle(document.body).backgroundColor,
      violations: run.violations.map((v) => v.id + " (" + v.impact + ", " + v.nodes.length + "): " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")),
      passed: run.passes.map((p) => p.id),
      unsettled: run.incomplete.filter((i) => i.id === "color-contrast").reduce((n, i) => n + i.nodes.length, 0),
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      layoutWidth: document.documentElement.clientWidth,
      navShown: link !== null && link.checkVisibility(),
      cspViolations: window.cspViolations,
    };
  })()`)) as Omit<Run, "label" | "policy">;
  return { label, policy, ...result };
}

beforeAll(async () => {
  for (const path of LEFTOVERS) rmSync(path, { recursive: true, force: true });
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });
  written = ["/_headers", "/_redirects"].map((path) => ({
    role: "tree-file" as const,
    path,
    contents: readFileSync(join(OUT, path), "utf8"),
  }));

  served = await serveBuild(OUT);
  const origin = served.origin;

  browser = await chromium.launch();
  runs = [];
  unfolded = [];
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height: 844 },
        // Without `isMobile` Chromium ignores the viewport meta, so a page missing one
        // would pass at 390 px (#568, #604).
        isMobile: width === 390,
      });
      await serveWrittenHeaders(context);
      const page = await context.newPage();
      for (const path of PAGES) {
        const policy = await visit(page, origin + path);
        runs.push(await audit(page, `${path} ${scheme} ${String(width)}px`, policy));
      }
      const searchPolicy = await visit(page, origin + "/search");
      await page.getByRole("combobox").fill(QUERY.text);
      await page.locator(`.fw-search__result[href="${QUERY.finds}"]`).waitFor();
      await page.keyboard.press("ArrowDown");
      runs.push(await audit(page, `/search?results ${scheme} ${String(width)}px`, searchPolicy));
      if (width === 390) {
        const navPolicy = await visit(page, origin + PAGES[1]);
        await page.locator(".fw-docnav__summary").click();
        unfolded.push(
          await page.locator(".fw-docnav a").first().isVisible(),
        );
        // Unfolded, because axe reads a closed `<details>`' contents as hidden.
        runs.push(await audit(page, `${PAGES[1]}?nav-open ${scheme} ${String(width)}px`, navPolicy));
      }
      await context.close();
    }
  }
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await served?.close();
  for (const path of LEFTOVERS) rmSync(path, { recursive: true, force: true });
});

const PER_LAYOUT = PAGES.length + 1;

test("every page, in both schemes and at both widths, has no axe violation", () => {
  expect(runs).toHaveLength(PER_LAYOUT * SCHEMES.length * WIDTHS.length + SCHEMES.length);
  const faults = runs.flatMap((run) =>
    run.violations.map((violation) => `  ${run.label}: ${violation}`),
  );
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("no page scrolls sideways on a 390 px phone, in either scheme", () => {
  const phone = runs.filter((run) => run.label.endsWith(" 390px"));
  expect(phone).toHaveLength((PER_LAYOUT + 1) * SCHEMES.length);
  expect(
    phone.filter((run) => run.layoutWidth !== 390).map((run) => `${run.label}: ${String(run.layoutWidth)}px`),
  ).toEqual([]);
  expect(
    phone.filter((run) => run.overflow > 0).map((run) => `${run.label}: ${String(run.overflow)}px`),
  ).toEqual([]);
});

test("the navigation is folded on a phone, opens from its summary, and is open on a desktop", () => {
  for (const run of runs) {
    expect(run.navShown, run.label).toBe(
      run.label.endsWith(" 1280px") || run.label.includes("?nav-open "),
    );
  }
  expect(unfolded).toEqual([true, true]);
});

test("every page, the driven search included, was served with the site's policy and reported no violation of it (#87)", () => {
  expect(runs).toHaveLength(PER_LAYOUT * SCHEMES.length * WIDTHS.length + SCHEMES.length);
  expect(runs.filter((run) => run.policy !== CONTENT_SECURITY_POLICY).map((run) => run.label)).toEqual([]);
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const violation of run.cspViolations) {
      const key = `${run.label}: ${violation}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const faults = [...counts].map(([key, count]) => `  ${key} ×${String(count)}`);
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
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
