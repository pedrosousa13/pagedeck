import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readManifest } from "@pagedeck/core";
import { BANNER_COPY } from "./consent-banner.test-support.js";
import type { Manifest } from "@pagedeck/core";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-consent-banner-test");
const DIST = join(SITE, "dist");
const SUPPORT = join(import.meta.dirname, "consent-banner.test-support.ts");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// Reviewed by hand, and React's own: an error-page prefix and XML namespace
// URIs, none fetched. Re-review on a React upgrade.
const PERMITTED_URLS: readonly string[] = [
  "https://react.dev/errors/",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
];

// Not every way to reach a network: React's own build creates script elements
// and calls `preinit`, so those cannot be denied.
const NETWORK_PRIMITIVES: readonly string[] = [
  "fetch(",
  "XMLHttpRequest",
  "sendBeacon",
  "importScripts",
  "EventSource",
  "WebSocket",
];

function absoluteUrls(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/https?:\/\/[^\s"'`<>\\)]+/g)].map(
        (match) => match[0],
      ),
    ),
  ].sort();
}

function referencedUrls(html: string): string[] {
  return [
    ...html.matchAll(/<[a-z]+\b[^>]*\b(?:src|href)="([^"]*)"/g),
  ].map((match) => match[1] as string);
}

function modulePreloads(html: string): string[] {
  return [...html.matchAll(/<link rel="modulepreload" href="([^"]*)">/g)].map(
    (match) => match[1] as string,
  );
}

let html = "";
let manifest: Manifest;
const scripts = new Map<string, string>();

// Stderr is not asserted here: Rolldown's load-dependent advisory would make
// this file flaky (#202), and `site.build.test.ts` holds that promise.
async function run(verb: string): Promise<void> {
  await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
}

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `import { bannerSiteConfig } from ${JSON.stringify(SUPPORT)};\nexport default bannerSiteConfig();\n`,
  );

  await run("sync");
  await run("build");

  manifest = readManifest(
    readFileSync(join(DIST, "manifest.json"), "utf8"),
    "manifest.json",
  );
  html = readFileSync(join(DIST, manifest.pages[0]?.html ?? ""), "utf8");
  for (const file of readdirSync(DIST, { recursive: true }).map(String)) {
    if (file.endsWith(".js")) {
      scripts.set(file, readFileSync(join(DIST, file), "utf8"));
    }
  }
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("the banner's whole markup is in the document the build wrote", () => {
  // Asserted as rendered markup, never as a bare value, which the island's
  // `data-fw-props` would satisfy alone.
  expect(html).toContain(`>${BANNER_COPY.heading}</h2>`);
  expect(html).toContain(`>${BANNER_COPY.body}</p>`);
  expect(html).toContain(`>${BANNER_COPY.acceptLabel}</button>`);
  expect(html).toContain(`>${BANNER_COPY.rejectLabel}</button>`);
  expect(html).toMatch(/<section [^>]*role="region"/);
  expect(html).toMatch(/aria-labelledby="fw-consent-banner-heading"/);
});

test("the build islands it from its own directive", () => {
  expect(html).toContain('data-fw-component="consent_banner"');
  expect(html).toContain('data-fw-mode="visible"');

  const page = manifest.pages[0];
  expect(page?.components.map((component) => component.name)).toEqual([
    "consent_banner",
  ]);
  expect(page?.components[0]?.module).toBe(
    "@pagedeck/design-system/components/consent_banner",
  );
  expect(page?.entryChunk).toBeDefined();
  expect(referencedUrls(html)).toEqual([...modulePreloads(html), page?.entryChunk]);
});

test("the document reaches no host at all", () => {
  const referenced = referencedUrls(html);
  expect(referenced.length).toBeGreaterThan(0);
  for (const url of referenced) {
    expect(url.startsWith("/")).toBe(true);
    expect(url.startsWith("//")).toBe(false);
    expect(existsSync(join(DIST, url))).toBe(true);
  }
  expect(absoluteUrls(html)).toEqual([]);
});

test("every absolute URL in the page's JavaScript is a reviewed one", () => {
  expect(scripts.size).toBeGreaterThan(0);
  const found: string[] = [];
  for (const [file, code] of scripts) {
    for (const url of absoluteUrls(code)) {
      if (!PERMITTED_URLS.some((permitted) => url.startsWith(permitted))) {
        found.push(`  ${file}: ${url}`);
      }
    }
  }
  expect(found.length === 0 ? "" : `\n${found.join("\n")}`).toBe("");
});

test("the payload names none of the calls a vendor phones home with", () => {
  const found: string[] = [];
  for (const [file, code] of scripts) {
    for (const primitive of NETWORK_PRIMITIVES) {
      if (code.includes(primitive)) found.push(`  ${file}: ${primitive}`);
    }
  }
  expect(found.length === 0 ? "" : `\n${found.join("\n")}`).toBe("");
});

test("the scan finds URLs when there are URLs to find", () => {
  expect(
    absoluteUrls('<script src="https://cdn.example.test/cmp.js"></script>'),
  ).toEqual(["https://cdn.example.test/cmp.js"]);
  expect(
    [...scripts.values()].flatMap((code) => absoluteUrls(code)).length,
  ).toBeGreaterThan(0);
});
