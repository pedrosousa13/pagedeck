import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { recordProxyInstance } from "./proxy-census.js";
import type { ProxyCensusRow } from "./proxy-census.js";

const dirs: string[] = [];
const CENSUS_PATH = "PAGEDECK_PROXY_CENSUS";
const before = process.env[CENSUS_PATH];

afterEach(() => {
  if (before === undefined) delete process.env[CENSUS_PATH];
  else process.env[CENSUS_PATH] = before;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function censusDir(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-proxy-census-"));
  dirs.push(dir);
  return { dir, path: join(dir, "census.jsonl") };
}

function row(overrides: Partial<ProxyCensusRow> = {}): ProxyCensusRow {
  return {
    entry: "/en/pricing",
    component: "BillingToggle",
    renderedBy: "PricingPage",
    prefix: "i0",
    refusedChildren: false,
    ...overrides,
  };
}

function rowsIn(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}

test("an unset PAGEDECK_PROXY_CENSUS writes nothing", () => {
  const { dir } = censusDir();
  delete process.env[CENSUS_PATH];

  recordProxyInstance(row());

  expect(readdirSync(dir)).toEqual([]);
});

test("an empty PAGEDECK_PROXY_CENSUS writes nothing, which is the guard's second clause", () => {
  const { dir } = censusDir();
  process.env[CENSUS_PATH] = "";

  recordProxyInstance(row());

  expect(readdirSync(dir)).toEqual([]);
});

test("an enabled census records one JSON line per instance, nulls included", () => {
  const { path } = censusDir();
  process.env[CENSUS_PATH] = path;

  recordProxyInstance(row({ renderedBy: null }));

  expect(rowsIn(path)).toEqual([
    {
      entry: "/en/pricing",
      component: "BillingToggle",
      renderedBy: null,
      prefix: "i0",
      refusedChildren: false,
    },
  ]);
});

test("a refused instance is recorded beside the population it is drawn from", () => {
  const { path } = censusDir();
  process.env[CENSUS_PATH] = path;

  recordProxyInstance(row({ component: "Card", prefix: "i0" }));
  recordProxyInstance(
    row({ component: "Accordion", prefix: "i1", refusedChildren: true }),
  );

  const rows = rowsIn(path) as ProxyCensusRow[];
  expect(rows.map((each) => each.component)).toEqual(["Card", "Accordion"]);
  expect(rows.map((each) => each.refusedChildren)).toEqual([false, true]);
});

test("rows accumulate, so a crashed build keeps what it measured", () => {
  const { path } = censusDir();
  process.env[CENSUS_PATH] = path;

  recordProxyInstance(row({ prefix: "i0" }));
  recordProxyInstance(row({ prefix: "i1" }));

  const rows = rowsIn(path) as ProxyCensusRow[];
  expect(rows.map((each) => each.prefix)).toEqual(["i0", "i1"]);
});

test("turning the census off mid-run stops it growing", () => {
  const { path } = censusDir();
  process.env[CENSUS_PATH] = path;
  recordProxyInstance(row());

  delete process.env[CENSUS_PATH];
  recordProxyInstance(row({ prefix: "i1" }));
  process.env[CENSUS_PATH] = "";
  recordProxyInstance(row({ prefix: "i2" }));

  expect(rowsIn(path)).toHaveLength(1);
});
