// Opt-in (`pnpm test:compiler-crash-harness`): the crash depth window moves with the
// host's stack. Re-run on a Node, Babel or React Compiler upgrade.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compileIslands } from "./react-compiler.js";
import {
  MEMO_CACHE_INIT,
  clientBuild,
} from "./react-compiler.test-support.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-compiler-crash/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;

const VENDOR = `${FIXTURE_DIR}node_modules/vendor-crash/index.jsx`;

// Measured: at 400 and below the chain compiles, from 500 to 2100 the compiler exhausts
// the stack, from 2400 Babel does first. 1000 sits between.
const CRASH_DEPTH = 1000;

function crashingModule(name: string): string {
  return [
    `"use client";`,
    `export default function ${name}(props) {`,
    `  const value = props${".a".repeat(CRASH_DEPTH)};`,
    `  return <p>{String(value)}</p>;`,
    `}`,
    "",
  ].join("\n");
}

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  writeFileSync(`${SRC}Crash.jsx`, crashingModule("Crash"));
  mkdirSync(dirname(VENDOR), { recursive: true });
  writeFileSync(VENDOR, crashingModule("VendorCrash"));
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

test("a component the compiler crashes on warns, and says it crashed", async () => {
  const entry = `${SRC}Crash.jsx`;
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(FIXTURE_DIR, [entry], [
    compiler.plugin,
  ]);

  expect(compiler.taken().join("\n")).toContain(
    `Module "${entry}" line 2: React Compiler crashed on component "Crash" — RangeError: Maximum call stack size exceeded. That is a fault in the compiler rather than a rule the component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash is logged whether or not the directive is present. It renders as written, without automatic memoization.`,
  );
  expect(compiler.taken().join("\n")).not.toContain("React Compiler skipped");
  expect(warnings).toEqual([]);
  expect(code).not.toMatch(MEMO_CACHE_INIT);
}, 60_000);

test("a crash inside a dependency warns, where a bailout in one does not", async () => {
  const compiler = compileIslands();
  const { code } = await clientBuild(FIXTURE_DIR, [VENDOR], [compiler.plugin]);

  expect(compiler.taken().join("\n")).toContain(
    `Module "${VENDOR}" line 2: React Compiler crashed on component "VendorCrash" — RangeError: Maximum call stack size exceeded.`,
  );
  expect(code).toContain("VendorCrash");
  expect(code).not.toMatch(MEMO_CACHE_INIT);
}, 60_000);
