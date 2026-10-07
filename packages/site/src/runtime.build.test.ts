import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runtimeVerdict } from "./audit.js";
import type { RuntimeSplit } from "./audit.js";
import {
  RUNTIME_CEILING,
  RUNTIME_URL,
  buildRuntimeSite,
  measureRuntime,
} from "./audit-site.js";

const SITE = join(import.meta.dirname, "..", ".pagedeck-runtime-build-test");

let split: RuntimeSplit;

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  const out = await buildRuntimeSite(SITE);
  split = measureRuntime(SITE, out);
  process.stdout.write(
    [
      "",
      `[#292] ${RUNTIME_URL} first-render JavaScript, on disk:`,
      `  framework's own   ${String(split.own.raw).padStart(7)} raw  ${String(split.own.gzip).padStart(6)} gzip  ${String(split.own.brotli).padStart(6)} brotli`,
      `  React             ${String(split.react.raw).padStart(7)} raw  ${String(split.react.gzip).padStart(6)} gzip  ${String(split.react.brotli).padStart(6)} brotli`,
      `  ceiling           ${String(RUNTIME_CEILING.raw).padStart(7)} raw  ${String(RUNTIME_CEILING.gzip).padStart(6)} gzip`,
      "",
    ].join("\n"),
  );
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("the framework's own JavaScript on the island page is within its ratcheted ceiling, raw and gzip", () => {
  const verdict = runtimeVerdict({ split, ceiling: RUNTIME_CEILING });
  expect(
    verdict.failures.map(
      (one) => `${one.url}: ${one.name} expected ${one.expected}, measured ${one.actual}`,
    ),
  ).toEqual([]);
  expect(verdict.assertions).toHaveLength(2);
});

test("React is what the measurement set apart, and it is most of what the page ships", () => {
  // React's renderer is far larger than the islands runtime, so a smaller React chunk
  // means the group caught the wrong modules.
  expect(split.react.raw).toBeGreaterThan(split.own.raw);
});
