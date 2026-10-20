// Opt-in (`pnpm test:compiler-crash-harness`): the crash depth window moves with the
// host's stack. Re-run on a Node or oxc-transform-react upgrade.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compileIslands, MODULE_TIME_LIMIT_MS } from "./react-compiler.js";
import {
  MEMO_CACHE_INIT,
  clientBuild,
} from "./react-compiler.test-support.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-compiler-crash/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;

const VENDOR = `${FIXTURE_DIR}node_modules/vendor-crash/index.jsx`;

// Measured (oxc-project/oxc#27995): 4925 compiles in 4.6 s, 4929 and above
// segfault, in 1.3 s from 6000. Rolldown prints a chain up to 5500 and drops an
// unused one up to 11000, so the crashing function is never the entry's export.
const CRASH_DEPTH = 7000;

// Measured: 3000 compiles in 0.7 s, 4000 in 3.2 s, growing about quadratically.
const SLOW_DEPTH = 3000;
const SLOW_LIMIT_MS = 100;

function chainModule(name: string, depth: number): string {
  return [
    `"use client";`,
    `export const label = "marker-${name}";`,
    `export default function ${name}(props) {`,
    `  const value = props${".a".repeat(depth)};`,
    `  return <p>{String(value)}</p>;`,
    `}`,
    "",
  ].join("\n");
}

function entryModule(name: string, from: string): string {
  return [
    `"use client";`,
    `import { label } from "${from}";`,
    `export default function ${name}({ items }) {`,
    `  const shouted = items.map((item) => item.toUpperCase());`,
    `  return <ul>{shouted.map((item) => <li key={item}>{label}{item}</li>)}</ul>;`,
    `}`,
    "",
  ].join("\n");
}

const CRASH_WARNING = (module: string, how: string): string =>
  `Module "${module}": React Compiler crashed — its process ${how} while compiling the module. That is a fault in the compiler rather than a rule a component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash happens whether or not the directive is present. The module renders as written, without automatic memoization.`;

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  writeFileSync(`${SRC}Crash.jsx`, chainModule("Crash", CRASH_DEPTH));
  writeFileSync(`${SRC}UsesCrash.jsx`, entryModule("UsesCrash", "./Crash.jsx"));
  writeFileSync(`${SRC}Slow.jsx`, chainModule("Slow", SLOW_DEPTH));
  writeFileSync(`${SRC}UsesSlow.jsx`, entryModule("UsesSlow", "./Slow.jsx"));
  mkdirSync(dirname(VENDOR), { recursive: true });
  writeFileSync(VENDOR, chainModule("VendorCrash", CRASH_DEPTH));
  writeFileSync(
    `${SRC}UsesVendor.jsx`,
    entryModule("UsesVendor", "vendor-crash"),
  );
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

test("a module the compiler's process dies on warns, says it crashed, and the entry still compiles", async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(
    FIXTURE_DIR,
    [`${SRC}UsesCrash.jsx`],
    [compiler.plugin],
  );

  expect(compiler.taken()).toEqual([
    CRASH_WARNING(`${SRC}Crash.jsx`, "exited on SIGSEGV"),
  ]);
  expect(warnings).toEqual([]);
  expect(code).toContain("marker-Crash");
  expect(code).toMatch(MEMO_CACHE_INIT);
}, 60_000);

test("a module past the time limit is killed and warned about the same way", async () => {
  const compiler = compileIslands({ moduleTimeLimitMs: SLOW_LIMIT_MS });
  const { code } = await clientBuild(
    FIXTURE_DIR,
    [`${SRC}UsesSlow.jsx`],
    [compiler.plugin],
  );

  expect(compiler.taken()).toContain(
    CRASH_WARNING(`${SRC}Slow.jsx`, `ran past ${String(SLOW_LIMIT_MS / 1000)} s`),
  );
  expect(code).toContain("marker-Slow");
}, 60_000);

test("the slow module clears the shipped limit", async () => {
  const compiler = compileIslands();
  const { code } = await clientBuild(
    FIXTURE_DIR,
    [`${SRC}UsesSlow.jsx`],
    [compiler.plugin],
  );

  expect(compiler.taken()).toEqual([]);
  expect(code).toContain("marker-Slow");
}, MODULE_TIME_LIMIT_MS + 60_000);

test("a crash inside a dependency warns, where a bailout in one does not", async () => {
  const compiler = compileIslands();
  const { code } = await clientBuild(
    FIXTURE_DIR,
    [`${SRC}UsesVendor.jsx`],
    [compiler.plugin],
  );

  expect(compiler.taken()).toEqual([
    CRASH_WARNING(VENDOR, "exited on SIGSEGV"),
  ]);
  expect(code).toContain("marker-VendorCrash");
}, 60_000);
