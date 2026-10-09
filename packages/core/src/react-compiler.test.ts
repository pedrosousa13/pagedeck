import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import react from "@vitejs/plugin-react";
import { compileIslands } from "./react-compiler.js";
import {
  MEMO_CACHE_IMPORT,
  MEMO_CACHE_INIT,
  clientBuild as buildFixture,
} from "./react-compiler.test-support.js";
import type { Plugin, PluginOption } from "vite";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-compiler-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;

function at(file: string): string {
  return isAbsolute(file) ? file : `${SRC}${file}`;
}

const VENDOR = `${FIXTURE_DIR}node_modules/vendor-widget/index.jsx`;

const FIXTURE: Record<string, string> = {
  "Counter.tsx": [
    `"use client";`,
    `export default function Counter({ items }: { items: readonly string[] }) {`,
    `  const shouted = items.map((item) => item.toUpperCase());`,
    `  return <ul>{shouted.map((item) => <li key={item}>{item}</li>)}</ul>;`,
    `}`,
    "",
  ].join("\n"),

  "Bailout.tsx": [
    `"use client";`,
    `export default function Bailout(props: { title: string }) {`,
    `  props.title = props.title.trim();`,
    `  return <p>{props.title}</p>;`,
    `}`,
    "",
  ].join("\n"),

  "OptedOut.tsx": [
    `"use client";`,
    `export default function OptedOut({ label }: { label: string }) {`,
    `  "use no memo";`,
    `  return <span>{label.trim()}</span>;`,
    `}`,
    "",
  ].join("\n"),

  // The one construct the two parser flags disagree about: with JSX on, `<string>value`
  // reads as an unterminated element.
  "Legacy.ts": [
    `export function shout(value: unknown): string {`,
    `  return (<string>value).toUpperCase() + "marker-legacy-4e83";`,
    `}`,
    "",
  ].join("\n"),

  "Static.tsx": [
    `export default function Static({ items }: { items: readonly string[] }) {`,
    `  const shouted = items.map((item) => item.toUpperCase());`,
    `  return <ul>{shouted.map((item) => <li key={item}>{item}</li>)}</ul>;`,
    `}`,
    "",
  ].join("\n"),
};

const VENDOR_SOURCE = [
  `"use client";`,
  `export default function VendorWidget(props) {`,
  `  props.title = props.title.trim();`,
  `  return <p>{props.title}</p>;`,
  `}`,
  "",
].join("\n");

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  for (const [file, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${file}`, source);
  }
  mkdirSync(dirname(VENDOR), { recursive: true });
  writeFileSync(VENDOR, VENDOR_SOURCE);
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

async function clientBuild(
  entries: readonly string[],
  plugins: readonly PluginOption[],
): Promise<{ code: string; warnings: string[] }> {
  return buildFixture(FIXTURE_DIR, entries.map(at), plugins);
}

function count(code: string, pattern: RegExp): number {
  return [...code.matchAll(pattern)].length;
}

function counting(plugin: Plugin, passes: Map<string, number>): Plugin {
  const transform = plugin.transform;
  if (typeof transform !== "function") {
    throw new Error("compileIslands no longer has a plain transform hook");
  }
  return {
    ...plugin,
    transform(code, id, options) {
      passes.set(id, (passes.get(id) ?? 0) + 1);
      return transform.call(this, code, id, options);
    },
  };
}

test("the fixture build is production-shaped", async () => {
  const { code } = await clientBuild(["Counter.tsx"], [compileIslands().plugin]);

  expect(code).toMatch(/\bjsx\(/);
  expect(code).not.toMatch(/\bjsxDEV\b/);
  expect(code).not.toContain("_jsxFileName");
}, 60_000);

test("an island component compiles through React Compiler", async () => {
  const { code } = await clientBuild(["Counter.tsx"], [compileIslands().plugin]);

  expect(code).toMatch(MEMO_CACHE_IMPORT);
  expect(code).toMatch(MEMO_CACHE_INIT);
}, 60_000);

test("a component the compiler refuses warns, naming the component and the rule", async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(["Bailout.tsx"], [
    compiler.plugin,
  ]);

  expect(compiler.taken()).toEqual([
    `Module "${at("Bailout.tsx")}" line 3: React Compiler skipped component "Bailout" — This value cannot be modified: Modifying component props or hook arguments is not allowed. Consider using a local variable instead. It renders as written, without automatic memoization.`,
  ]);
  expect(warnings).toEqual([]);
  expect(code).not.toMatch(MEMO_CACHE_INIT);
}, 60_000);

test("a second build through one pass does not pool the first build's warnings", async () => {
  const compiler = compileIslands();

  await clientBuild(["Bailout.tsx"], [compiler.plugin]);
  const first = compiler.taken();
  await clientBuild(["Bailout.tsx"], [compiler.plugin]);

  expect(compiler.taken()).toEqual(first);
  expect(first).toHaveLength(1);
}, 60_000);

test('a component opting out with "use no memo" is not warned about', async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(["OptedOut.tsx"], [
    compiler.plugin,
  ]);

  expect(compiler.taken()).toEqual([]);
  expect(warnings).toEqual([]);
  expect(code).not.toMatch(MEMO_CACHE_INIT);
}, 60_000);

test("a .ts module using a legacy type assertion still parses", async () => {
  const { code } = await clientBuild(["Legacy.ts"], [compileIslands().plugin]);

  expect(code).toContain("marker-legacy-4e83");
}, 60_000);

// Counted, not read off the output: the compiler's output is a fixed point, so a double
// compile is invisible in emitted code.
test("the standard React plugin does not compile the island a second time", async () => {
  const passes = new Map<string, number>();
  const withReact = await clientBuild(
    ["Counter.tsx"],
    [react(), counting(compileIslands().plugin, passes)],
  );
  const reactAlone = await clientBuild(["Counter.tsx"], [react()]);

  expect(withReact.code).toMatch(MEMO_CACHE_INIT);
  expect(passes.get(at("Counter.tsx"))).toBe(1);
  expect([...passes].filter(([, times]) => times !== 1)).toEqual([]);
  expect(reactAlone.code).not.toMatch(MEMO_CACHE_IMPORT);
  expect(reactAlone.code).not.toMatch(MEMO_CACHE_INIT);
}, 60_000);

test("a second compiler pass over the same module changes nothing", async () => {
  const once = await clientBuild(["Counter.tsx"], [compileIslands().plugin]);
  const twice = await clientBuild(
    ["Counter.tsx"],
    [compileIslands().plugin, compileIslands().plugin],
  );

  expect(twice.code).toBe(once.code);
  expect(count(twice.code, MEMO_CACHE_INIT)).toBe(1);
}, 60_000);

test("a build without this plugin has no compiler output", async () => {
  const withoutPlugin = await clientBuild(["Static.tsx"], []);
  const withPlugin = await clientBuild(["Static.tsx"], [compileIslands().plugin]);

  expect(withoutPlugin.code).not.toMatch(MEMO_CACHE_IMPORT);
  expect(withoutPlugin.code).not.toMatch(MEMO_CACHE_INIT);
  expect(count(withPlugin.code, MEMO_CACHE_INIT)).toBe(1);
}, 60_000);

test("a bailout inside a dependency is compiled but not warned about", async () => {
  const compiler = compileIslands();
  const { code } = await clientBuild([VENDOR], [compiler.plugin]);

  expect(compiler.taken()).toEqual([]);
  expect(code).toContain("VendorWidget");
}, 60_000);

const COMPILABLE = [
  `export default function Widget({ items }) {`,
  `  const shouted = items.map((item) => item.toUpperCase());`,
  `  return <ul>{shouted.map((item) => <li key={item}>{item}</li>)}</ul>;`,
  `}`,
  "",
].join("\n");

function transformed(id: string): unknown {
  const transform = compileIslands().plugin.transform;
  if (typeof transform !== "function") {
    throw new Error("compileIslands no longer has a plain transform hook");
  }
  return transform.call({} as never, COMPILABLE, id, undefined);
}

test.each([
  "/site/node_modules/.pnpm/react@19.2.8/node_modules/react/cjs/react.production.js",
  "/site/node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/cjs/react-dom-client.production.js",
  "/site/node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.production.js",
  "/site/node_modules/react/cjs/react.production.js",
  "/site/node_modules/react-dom/cjs/react-dom-client.production.js",
  "/site/node_modules/scheduler/cjs/scheduler.production.js",
])("React's own runtime module %s passes through untransformed", (id) => {
  expect(transformed(id)).toBeNull();
});

test.each([
  "/site/node_modules/.pnpm/react-aria@3.0.0/node_modules/react-aria/dist/index.jsx",
  "/site/node_modules/react-dom-extra/index.jsx",
  "/site/node_modules/@scope/react/index.jsx",
  "/site/node_modules/react/node_modules/vendor-widget/index.jsx",
])("a module of another package, %s, is still compiled", (id) => {
  expect(String((transformed(id) as { code: string }).code)).toMatch(MEMO_CACHE_INIT);
});
