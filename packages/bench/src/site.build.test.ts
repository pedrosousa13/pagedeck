import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER, readManifest } from "@pagedeck/core";
import type { Manifest } from "@pagedeck/core";
import { generateSyntheticSite } from "./generate.js";
import type { SyntheticSite } from "./generate.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-site-build-test");
const OUT = join(SITE, "dist");

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// Twelve over two locales: two turns of the three-shape cycle in each locale.
const PAGES = 12;
const LOCALES = 2;

async function run(verb: string): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  // Checks whether the framework wrote anything, not whether stderr is empty (#184).
  expect(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  ).toBe("");
}

let site: SyntheticSite;
let manifest: Manifest;

beforeAll(async () => {
  site = generateSyntheticSite({ directory: SITE, pages: PAGES, locales: LOCALES });
  await run("sync");
  await run("build");
  manifest = readManifest(
    readFileSync(join(OUT, "manifest.json"), "utf8"),
    "manifest.json",
  );
  // A ceiling that catches a hang, not a performance assertion.
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("the build routes exactly the pages the generator wrote", () => {
  expect(manifest.pages).toHaveLength(site.pages);
  expect([...new Set(manifest.pages.map((row) => row.locale))].sort()).toEqual(
    [...site.locales].sort(),
  );
});

test("both of spec §7's page modes reach the emitted documents", () => {
  const templated = manifest.pages.filter((row) => row.template !== undefined);
  const trees = manifest.pages.filter((row) => row.template === undefined);
  expect(templated.length).toBeGreaterThan(0);
  expect(trees.length).toBeGreaterThan(0);

  // Read off the HTML: a mode that planned and did not render passes a row check.
  const document = (output: string): string =>
    readFileSync(join(OUT, output, "index.html"), "utf8");
  expect(document(templated[0]?.output as string)).toContain('class="doc"');
  expect(document(trees[0]?.output as string)).toContain('class="card"');
});

test("the islanded pages are the ones the generator counted, and their chunk was emitted", () => {
  const islanded = manifest.pages.filter((row) => row.entryChunk !== undefined);
  expect(islanded).toHaveLength(site.islandPages);
  for (const row of islanded) {
    expect(existsSync(join(OUT, row.entryChunk as string))).toBe(true);
  }
  expect(
    readdirSync(join(OUT, "assets")).some((name) => /^fw-core-.+\.js$/.test(name)),
  ).toBe(true);
});

test("the store the build read is the file the harness measures", () => {
  expect(existsSync(join(SITE, "content.db"))).toBe(true);
});
