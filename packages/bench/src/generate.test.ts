import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { FixtureFile } from "@pagedeck/fixtures";
import type { FixturePage } from "@pagedeck/fixtures";
import { generateSyntheticSite } from "./generate.js";

const TEMP = mkdtempSync(join(tmpdir(), "pagedeck-bench-generate-"));

afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

function fixtures(directory: string): {
  file: string;
  payload: FixtureFile<FixturePage>;
}[] {
  const root = join(directory, "content");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return {
        file,
        payload: JSON.parse(readFileSync(file, "utf8")) as FixtureFile<FixturePage>,
      };
    });
}

test("the generated site holds exactly the pages it reports, across the locales it declares", () => {
  const directory = join(TEMP, "counted");
  // 25 over 3 divides unevenly on purpose: the returned count must still be exact.
  const site = generateSyntheticSite({ directory, pages: 25, locales: 3 });

  expect(site.pages).toBe(25);
  expect(fixtures(directory)).toHaveLength(25);
  expect(site.locales).toHaveLength(3);
  expect(readdirSync(join(directory, "content")).sort()).toEqual(
    [...site.locales].sort(),
  );
});

test("every generated entry is one of spec §7's two page modes, and both are generated", () => {
  const directory = join(TEMP, "moded");
  const generated = fixtures(
    generateSyntheticSite({ directory, pages: 12, locales: 2 }).directory,
  ).map(({ payload }) => payload);

  expect(generated.every((one) => Number.isInteger(one.rev) && one.rev >= 1)).toBe(
    true,
  );
  const modes = generated.map((one) => one.data?.mode);
  expect([...new Set(modes)].sort()).toEqual(["template", "tree"]);
  const trees = generated.filter((one) => one.data?.mode === "tree");
  expect(
    trees.every(
      (one) =>
        one.data?.mode === "tree" &&
        one.data.tree.some((node) => (node.children ?? []).length > 0),
    ),
  ).toBe(true);
});

test("a share of the generated pages island, so the client build has entries to emit", () => {
  const directory = join(TEMP, "islanded");
  const site = generateSyntheticSite({ directory, pages: 30, locales: 1 });

  expect(site.islandPages).toBeGreaterThan(0);
  expect(site.islandPages).toBeLessThan(site.pages);
});

test("two locales are given different content, so a rung is not one locale counted twice", () => {
  const directory = join(TEMP, "translated");
  generateSyntheticSite({ directory, pages: 12, locales: 2 });
  const [first, second] = readdirSync(join(directory, "content")).sort();

  const read = (locale: string): string =>
    readFileSync(
      join(directory, "content", locale, "guides", "guide-0.json"),
      "utf8",
    );
  expect(read(first as string)).not.toBe(read(second as string));
});

test("the prose is drawn from a vocabulary too large for gzip to code as a handful of words", () => {
  const directory = join(TEMP, "worded");
  generateSyntheticSite({ directory, pages: 12, locales: 2 });
  const words = new Set(
    fixtures(directory)
      .flatMap(({ payload }) => JSON.stringify(payload).match(/[a-z]{3,}/g) ?? [])
      .filter((word) => word.length > 2),
  );

  expect(words.size).toBeGreaterThan(200);
});

test("the config it writes loads the site through this package's own name", () => {
  const directory = join(TEMP, "configured");
  generateSyntheticSite({ directory, pages: 4, locales: 1 });
  const config = readFileSync(join(directory, "pagedeck.config.ts"), "utf8");

  // Types are stripped, so a relative `.js` would resolve to a file only `tsc` emits (#182).
  expect(config).toContain('from "@pagedeck/bench"');
  expect(config).not.toContain("./");
});

test("a locale count beyond the declared codes is refused rather than invented", () => {
  expect(() =>
    generateSyntheticSite({ directory: join(TEMP, "toowide"), pages: 4, locales: 99 }),
  ).toThrow(/99 locales/);
});
