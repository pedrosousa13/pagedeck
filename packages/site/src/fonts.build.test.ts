import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readManifest } from "@pagedeck/core";
import type { Manifest, ManifestFile } from "@pagedeck/core";
import { defineFontSubset } from "@pagedeck/font-subset";
import { siteConfig } from "./site.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-fonts-build-test");
const OUT = join(SITE, "site");

const FW = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const FONTS_DIR = join(import.meta.dirname, "..", "fonts");
const SOURCE_SIZE: Readonly<Record<string, number>> = {
  regular: statSync(join(FONTS_DIR, "FiraSans-Regular.ttf")).size,
  semibold: statSync(join(FONTS_DIR, "FiraSans-SemiBold.ttf")).size,
};

function writeSite(): void {
  mkdirSync(SITE, { recursive: true });
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    ['import { siteConfig } from "@pagedeck/site";', "", "export default siteConfig();", ""].join(
      "\n",
    ),
  );
}

async function pagedeck(verb: string): Promise<void> {
  await execFileAsync(process.execPath, [FW, verb], { cwd: SITE });
}

function document(output: string): string {
  return readFileSync(join(OUT, output, "index.html"), "utf8");
}

let manifest: Manifest;
let fontFiles: readonly ManifestFile[];
let stylesheet: ManifestFile | undefined;
let stylesheetCss: string;

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  writeSite();
  await pagedeck("sync");
  await pagedeck("build");

  const manifestFile = join(OUT, "manifest.json");
  manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  fontFiles = manifest.files.filter((file) => file.path.startsWith("/fonts/"));
  stylesheet = fontFiles.find((file) => file.kind === "css");
  stylesheetCss = readFileSync(
    join(OUT, (stylesheet as ManifestFile).path.slice(1)),
    "utf8",
  );
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("both declared faces' subsets are written as hashed assets, each smaller than its source font", () => {
  const regular = fontFiles.find(
    (file) => file.kind === "asset" && file.path.includes("fira-sans-400-normal"),
  );
  const semibold = fontFiles.find(
    (file) => file.kind === "asset" && file.path.includes("fira-sans-600-normal"),
  );

  for (const [name, file] of [
    ["Fira Sans Regular", regular],
    ["Fira Sans SemiBold", semibold],
  ] as const) {
    expect(file, name).toBeDefined();
    const found = file as ManifestFile;
    expect(found.path, name).toMatch(/^\/fonts\/fira-sans-\d+-normal\.[0-9a-f]{8}\.woff2$/);
    expect(existsSync(join(OUT, found.path.slice(1))), name).toBe(true);
  }

  // Smaller than the source font, not merely present: what catches a subsetter passing
  // its input straight through.
  const regularSize = statSync(join(OUT, (regular as ManifestFile).path.slice(1))).size;
  const semiboldSize = statSync(join(OUT, (semibold as ManifestFile).path.slice(1))).size;
  expect(regularSize).toBeGreaterThan(0);
  expect(regularSize).toBeLessThan(SOURCE_SIZE["regular"] as number);
  expect(semiboldSize).toBeGreaterThan(0);
  expect(semiboldSize).toBeLessThan(SOURCE_SIZE["semibold"] as number);
});

test("the emitted stylesheet carries Fira Sans's @font-face, its unicode-range, and a metric-adjusted fallback", () => {
  const regular = fontFiles.find(
    (file) => file.kind === "asset" && file.path.includes("fira-sans-400-normal"),
  ) as ManifestFile;

  expect(stylesheetCss).toContain(`src: url("${regular.path}") format("woff2")`);
  expect(stylesheetCss).toContain('font-family: "Fira Sans"');
  expect(stylesheetCss).toContain("font-weight: 400;");
  expect(stylesheetCss).toContain(
    "unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2018-201E, U+2026, U+20AC;",
  );

  expect(stylesheetCss).toContain('font-family: "Helvetica"');
  expect(stylesheetCss).toContain('src: local("Helvetica")');
  expect(stylesheetCss).toMatch(/size-adjust: \d+\.\d{4}%;/);
  expect(stylesheetCss).toMatch(/ascent-override: \d+\.\d{4}%;/);
  expect(stylesheetCss).toMatch(/descent-override: \d+\.\d{4}%;/);
  expect(stylesheetCss).toMatch(/line-gap-override: \d+\.\d{4}%;/);
});

test("the preload link reaches a document for the above-fold face and not for the below-fold one", () => {
  const regular = fontFiles.find(
    (file) => file.kind === "asset" && file.path.includes("fira-sans-400-normal"),
  ) as ManifestFile;
  const semibold = fontFiles.find(
    (file) => file.kind === "asset" && file.path.includes("fira-sans-600-normal"),
  ) as ManifestFile;

  const home = document("en");
  expect(home).toContain(
    `<link rel="preload" href="${regular.path}" as="font" type="font/woff2" crossorigin>`,
  );
  expect(home).not.toContain(`href="${semibold.path}"`);
});

test("the font stylesheet reaches every document this build wrote, content page and island page alike", () => {
  const link = `<link rel="stylesheet" href="${(stylesheet as ManifestFile).path}">`;
  for (const output of ["en", "de", join("en", "legal", "terms"), join("en", "pricing")]) {
    expect(document(output)).toContain(link);
  }
});

test("subsetting the real Fira Sans face twice, through the adapter directly, produces byte-identical output", async () => {
  // Determinism against the real font: the repo's other font check subsets a synthetic
  // fixture, which cannot surface a nondeterminism tied to a real typeface's tables.
  const regular = siteConfig().build?.fonts?.faces.find((face) => face.weight === 400);
  if (regular === undefined) {
    throw new Error("../site's `FONTS` declares no weight-400 Fira Sans face to test against");
  }

  const adapter = defineFontSubset();
  const request = {
    family: regular.family,
    src: regular.src,
    unicodeRanges: regular.unicodeRanges,
  };
  const first = await adapter.subset(request);
  const second = await adapter.subset(request);

  expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
  expect(second.metrics).toEqual(first.metrics);
});
