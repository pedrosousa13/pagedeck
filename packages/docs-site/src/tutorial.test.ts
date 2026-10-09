import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fences, STARTER_TEMPLATE, TUTORIAL } from "./tutorial.test-support.js";

const PAGE = fences(readFileSync(TUTORIAL, "utf8"));

const FILES = PAGE.filter(({ lang }) => lang !== "sh");

const quoted = (file: string): boolean => existsSync(join(STARTER_TEMPLATE, file));

test("every fence that is not a shell command names its file in the line before it, ending `path`:", () => {
  expect(
    FILES.filter(({ file }) => file === undefined).map(({ code }) => code.split("\n")[0]),
  ).toEqual([]);
});

test("every starter file the tutorial quotes is the file create-pagedeck writes, byte for byte", () => {
  const quotes = FILES.filter(({ file }) => file !== undefined && quoted(file));
  expect(quotes.map(({ file }) => file)).toContain("pagedeck.config.ts");
  for (const { file, code } of quotes) {
    expect(code, `${file as string} as the tutorial quotes it`).toBe(
      readFileSync(join(STARTER_TEMPLATE, file as string), "utf8"),
    );
  }
});

test("every other file the tutorial has the reader write is a new markdown page", () => {
  const written = FILES.flatMap(({ file }) => (file === undefined || quoted(file) ? [] : [file]));
  expect(written.length).toBeGreaterThan(0);
  expect(written.filter((file) => !/^content\/.+\.md$/.test(file))).toEqual([]);
});
