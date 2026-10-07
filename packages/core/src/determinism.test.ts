import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { diffOutputTrees, outputDifferenceReport } from "./determinism.js";

const written: string[] = [];

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-determinism-"));
  written.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return dir;
}

function manifest(stamp: string, hash: string): string {
  return `${JSON.stringify(
    {
      version: 3,
      build: { id: stamp, createdAt: "2026-08-26T00:00:00.000Z" },
      files: [{ path: "/index.html", kind: "html", hash, size: 10 }],
    },
    null,
    2,
  )}\n`;
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two trees holding the same bytes differ in nothing", () => {
  const files = {
    "index.html": "<!doctype html>\n",
    "assets/index-abc123.js": "console.log(0)\n",
  };

  expect(diffOutputTrees(tree(files), tree(files))).toEqual([]);
});

test("a file whose bytes differ is reported and named", () => {
  const first = tree({ "assets/index-abc123.js": "console.log(0)\n" });
  const second = tree({ "assets/index-abc123.js": "console.log(1)\n" });

  expect(diffOutputTrees(first, second)).toEqual([
    { path: "assets/index-abc123.js", difference: "bytes" },
  ]);
});

test("a file only one build emitted is reported on the side that has it", () => {
  const first = tree({ "index.html": "<!doctype html>\n" });
  const second = tree({
    "index.html": "<!doctype html>\n",
    "about/index.html": "<!doctype html>\n",
  });

  expect(diffOutputTrees(first, second)).toEqual([
    { path: "about/index.html", difference: "second-only" },
  ]);
  expect(diffOutputTrees(second, first)).toEqual([
    { path: "about/index.html", difference: "first-only" },
  ]);
});

test("differences are reported in path order however the directories are read", () => {
  const first = tree({ "b.js": "1\n", "a/deep.js": "1\n", "c.js": "1\n" });
  const second = tree({ "b.js": "2\n", "a/deep.js": "2\n", "c.js": "2\n" });

  expect(diffOutputTrees(first, second).map((entry) => entry.path)).toEqual([
    "a/deep.js",
    "b.js",
    "c.js",
  ]);
});

test("a manifest that differs only in its build stamp is not a difference", () => {
  const first = tree({ "manifest.json": manifest("build-1", "abc") });
  const second = tree({ "manifest.json": manifest("build-2", "abc") });

  expect(diffOutputTrees(first, second)).toEqual([]);
});

test("a manifest that differs anywhere but its build stamp is a difference", () => {
  const first = tree({ "manifest.json": manifest("build-1", "abc") });
  const second = tree({ "manifest.json": manifest("build-2", "def") });

  expect(diffOutputTrees(first, second)).toEqual([
    { path: "manifest.json", difference: "bytes" },
  ]);
});

test("the stamp exception applies to the root manifest and to no other document", () => {
  const first = tree({ "data/manifest.json": manifest("build-1", "abc") });
  const second = tree({ "data/manifest.json": manifest("build-2", "abc") });

  expect(diffOutputTrees(first, second)).toEqual([
    { path: "data/manifest.json", difference: "bytes" },
  ]);
});

test("a manifest that is not readable JSON is compared as bytes", () => {
  const first = tree({ "manifest.json": "{ truncated\n" });
  const second = tree({ "manifest.json": "{ truncated\n" });
  const third = tree({ "manifest.json": "{ truncate\n" });

  expect(diffOutputTrees(first, second)).toEqual([]);
  expect(diffOutputTrees(first, third)).toEqual([
    { path: "manifest.json", difference: "bytes" },
  ]);
});

test("the report names both trees, every offending file, and what is wrong with each", () => {
  const report = outputDifferenceReport(
    { first: "/site/dist-first", second: "/site/dist" },
    [
      { path: "assets/index-abc123.js", difference: "bytes" },
      { path: "about/index.html", difference: "first-only" },
      { path: "search/index.html", difference: "second-only" },
    ],
  );

  expect(report).toBe(
    [
      'Build-twice determinism: 3 files differ between "/site/dist-first" and "/site/dist" — two builds of one unchanged site must emit the same bytes, so the build must not read a clock, a random source or an unordered collection:',
      "  assets/index-abc123.js — the bytes differ",
      "  about/index.html — only /site/dist-first has it",
      "  search/index.html — only /site/dist has it",
    ].join("\n"),
  );
});

test("the report counts one file in the singular", () => {
  expect(
    outputDifferenceReport({ first: "/a", second: "/b" }, [
      { path: "index.html", difference: "bytes" },
    ]),
  ).toContain("1 file differs between");
});
