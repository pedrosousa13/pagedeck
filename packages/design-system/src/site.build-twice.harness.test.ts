import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildTwiceFailure } from "./site.build-twice.harness.js";

const written: string[] = [];

const SPAWNED: readonly [number, number] = [process.pid + 1, process.pid + 2];

let minted = 0;
function stampedManifest(): string {
  minted += 1;
  return `${JSON.stringify({
    version: 1,
    build: { id: `stamp-${String(minted)}`, createdAt: "2026-08-29T19:18:37Z" },
  })}\n`;
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-build-twice-"));
  written.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return dir;
}

function builtTree(files: Record<string, string> = {}): string {
  return tree({
    "manifest.json": stampedManifest(),
    "assets/pricing_page-LxQj-GW1.js": "console.log(0)\n",
    ...files,
  });
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two trees a build wrote the same bytes into are no failure", () => {
  const files = {
    "index.html": "<!doctype html>\n",
    "assets/index-abc123.js": "console.log(0)\n",
  };

  expect(
    buildTwiceFailure(
      { first: builtTree(files), second: builtTree(files) },
      SPAWNED,
    ),
  ).toBe(undefined);
});

test("a file whose bytes moved fails, and the failure names it", () => {
  const first = builtTree({ "about/index.html": "<p>7</p>\n" });
  const second = builtTree({ "about/index.html": "<p>3</p>\n" });

  const failure = buildTwiceFailure({ first, second }, SPAWNED);

  expect(failure).toContain("about/index.html — the bytes differ");
  expect(failure).toContain(first);
  expect(failure).toContain(second);
});

test("a build that ran in this process fails, whatever its tree holds", () => {
  const trees = { first: builtTree(), second: builtTree() };

  const failure = buildTwiceFailure(trees, [process.pid, process.pid + 1]);

  expect(failure).toContain("ran in this process");
});

test("two builds that shared one process fail", () => {
  const trees = { first: builtTree(), second: builtTree() };

  const failure = buildTwiceFailure(trees, [process.pid + 1, process.pid + 1]);

  expect(failure).toContain("one process");
});

test("two empty trees fail rather than pass, because nothing was compared", () => {
  const failure = buildTwiceFailure(
    { first: tree({}), second: tree({}) },
    SPAWNED,
  );

  expect(failure).toContain("emitted no files");
});

test("a tree with no island chunk fails, because the client path went unbuilt", () => {
  const failure = buildTwiceFailure(
    {
      first: builtTree(),
      second: tree({ "manifest.json": stampedManifest() }),
    },
    SPAWNED,
  );

  expect(failure).toContain("no assets/pricing_page-*.js chunk");
});

test("two manifests carrying one build stamp fail, excused field or not", () => {
  const stamp = stampedManifest();
  const failure = buildTwiceFailure(
    {
      first: builtTree({ "manifest.json": stamp }),
      second: builtTree({ "manifest.json": stamp }),
    },
    SPAWNED,
  );

  expect(failure).toContain("carry the same build stamp");
});

test("a tree whose manifest holds no build stamp fails", () => {
  const failure = buildTwiceFailure(
    {
      first: builtTree(),
      second: builtTree({
        "manifest.json": `${JSON.stringify({ version: 1 })}\n`,
      }),
    },
    SPAWNED,
  );

  expect(failure).toContain("no build stamp to excuse");
});
