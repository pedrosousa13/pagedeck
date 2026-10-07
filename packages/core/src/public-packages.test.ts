import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { packedBesideDist } from "./public-packages.test-support.js";

const DIST_ONLY = ["dist", "!dist/.tsbuildinfo"];

test("a package whose files names only dist packs nothing beside it", () => {
  expect([...packedBesideDist({ name: "@pagedeck/core", files: DIST_ONLY })]).toEqual([]);
  expect([...packedBesideDist({ name: "@pagedeck/core" })]).toEqual([]);
});

test("any package but create-pagedeck packs nothing beside dist, even a file its files names", () => {
  expect([
    ...packedBesideDist({ name: "@pagedeck/brand", files: [...DIST_ONLY, "brand.css", "template/x.md"] }),
  ]).toEqual([]);
});

test("create-pagedeck may pack each template file its files names, and nothing else beside dist", () => {
  const admitted = packedBesideDist({
    name: "create-pagedeck",
    files: [...DIST_ONLY, "template/README.md", "template/_gitignore", "notes.txt"],
  });

  expect(
    [
      "template/README.md",
      "template/_gitignore",
      "notes.txt",
      "template/.env",
      "template/node_modules/x/index.js",
    ].filter((entry) => !admitted.has(entry)),
  ).toEqual(["notes.txt", "template/.env", "template/node_modules/x/index.js"]);
});

test("a directory in create-pagedeck's files admits none of the files packed under it", () => {
  expect(
    packedBesideDist({ name: "create-pagedeck", files: [...DIST_ONLY, "template"] }).has(
      "template/README.md",
    ),
  ).toBe(false);
});

test("create-pagedeck's files admits its template file by file", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "create-pagedeck", "package.json"), "utf8"),
  ) as { name: string; files: string[] };

  expect(packedBesideDist(manifest).has("template/pagedeck.config.ts")).toBe(true);
});
