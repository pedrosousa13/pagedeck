import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "..", "core", "dist", "bin.js");
// Inside the package, so the site resolves `@pagedeck/*` and React from its node_modules (#77).
const SITE = mkdtempSync(join(PACKAGE, ".pagedeck-template-build-test-"));

let buildStderr = "";

interface Manifest {
  pages: { path: string; output: string }[];
}

beforeAll(async () => {
  cpSync(join(PACKAGE, "template"), SITE, { recursive: true });
  renameSync(join(SITE, "_gitignore"), join(SITE, ".gitignore"));
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  ({ stderr: buildStderr } = await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE }));
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

test("the template's build prints no favicon warning", () => {
  expect(buildStderr.split("\n").filter((line) => line.includes("Favicon:"))).toEqual([]);
});

test("the template's build writes the template's favicon.ico at /favicon.ico, byte for byte", () => {
  expect(readFileSync(join(SITE, "site", "favicon.ico"))).toEqual(
    readFileSync(join(PACKAGE, "template", "favicon.ico")),
  );
});
