import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "..", "core", "dist", "bin.js");
// Inside the package, so the site resolves `@pagedeck/*` and React from its node_modules (#77).
const SITE = mkdtempSync(join(PACKAGE, ".pagedeck-template-build-test-"));

interface Manifest {
  pages: { path: string; output: string }[];
}

beforeAll(async () => {
  cpSync(join(PACKAGE, "template"), SITE, { recursive: true });
  renameSync(join(SITE, "_gitignore"), join(SITE, ".gitignore"));
  writeFileSync(join(SITE, "content", "tom-and-jerry.md"), "# Tom &amp; Jerry\n\nA page.\n");
  for (const verb of ["sync", "build"]) {
    await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
  }
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("every page the template builds declares one viewport in <head>", () => {
  const { pages } = JSON.parse(readFileSync(join(SITE, "site", "manifest.json"), "utf8")) as Manifest;
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    const html = readFileSync(join(SITE, "site", page.output, "index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(
      head.match(/<meta name="viewport" content="width=device-width, initial-scale=1"\/?>/g)?.length,
      page.path,
    ).toBe(1);
    expect(html.split('name="viewport"').length - 1, page.path).toBe(1);
  }
});

test("a character reference in a page's heading reaches <title> escaped once (#101)", () => {
  const { pages } = JSON.parse(readFileSync(join(SITE, "site", "manifest.json"), "utf8")) as Manifest;
  const page = pages.find((one) => one.path === "/tom-and-jerry/");
  expect(page).toBeDefined();
  const html = readFileSync(join(SITE, "site", page?.output ?? "", "index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain("<title>Tom &amp; Jerry</title>");
  expect(html).not.toContain("&amp;amp;");
});
