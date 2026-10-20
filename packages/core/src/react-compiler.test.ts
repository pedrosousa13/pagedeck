import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import react from "@vitejs/plugin-react";
import { ConfigError } from "./exit.js";
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

  "OptedOutBailout.tsx": [
    `"use client";`,
    `export function Marked(props: { title: string }) {`,
    `  "use no forget";`,
    `  props.title = props.title.trim();`,
    `  return <p>{props.title}</p>;`,
    `}`,
    `export default function Unmarked(props: { title: string }) {`,
    `  props.title = props.title.trim();`,
    `  return <Marked title={props.title} />;`,
    `}`,
    "",
  ].join("\n"),

  "ModuleOptedOut.tsx": [
    `"use client";`,
    `"use no memo";`,
    `export default function ModuleOptedOut(props: { title: string }) {`,
    `  props.title = props.title.trim();`,
    `  return <p>{props.title}</p>;`,
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

  // 18 bytes of UTF-8 past its length in UTF-16 before the component.
  "Accented.tsx": [
    `"use client";`,
    `const label = "héllo wörld — ünïcode ✓";`,
    `export default function Accented(props: { title: string }) {`,
    `  props.title = props.title.trim();`,
    `  return <p>{label}{props.title}</p>;`,
    `}`,
    "",
  ].join("\n"),

  "Broken.tsx": [
    `"use client";`,
    `export default function Broken( {`,
    `  return <p>;`,
    `}`,
    "",
  ].join("\n"),

  // oxc-project/oxc#27995: a member chain this deep segfaults the compiler, from
  // 4929 on the dev box. Rolldown drops the unused function before printing it,
  // which it could not do past 11000; `label` is what the entry keeps.
  "Crash.jsx": [
    `"use client";`,
    `export const label = "marker-crash-2b7e";`,
    `export default function Crash(props) {`,
    `  const value = props${".a".repeat(7000)};`,
    `  return <p>{String(value)}</p>;`,
    `}`,
    "",
  ].join("\n"),

  "UsesCrash.tsx": [
    `"use client";`,
    `import { label } from "./Crash.jsx";`,
    `export default function UsesCrash({ items }: { items: readonly string[] }) {`,
    `  const shouted = items.map((item) => item.toUpperCase());`,
    `  return <ul>{shouted.map((item) => <li key={item}>{label}{item}</li>)}</ul>;`,
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
  guarded: readonly Plugin[] = [],
): Promise<{ code: string; warnings: string[] }> {
  return buildFixture(FIXTURE_DIR, entries.map(at), plugins, guarded);
}

function count(code: string, pattern: RegExp): number {
  return [...code.matchAll(pattern)].length;
}

// `pgrep` exits 1 for no match. Polled: a killed child is listed until reaped.
async function workersLeft(): Promise<string[]> {
  const deadline = Date.now() + 3_000;
  let found: string[] = [];
  do {
    found = await new Promise<string[]>((resolve) => {
      execFile(
        "pgrep",
        ["-P", String(process.pid), "-f", "react-compiler-worker"],
        (_error, stdout) => {
          resolve(stdout.split("\n").filter((line) => line !== ""));
        },
      );
    });
    if (found.length === 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return found;
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

const MUTATION =
  "This value cannot be modified: Do not mutate component props or hook arguments. If the value should change, update it where it is owned and pass an update callback, or use local state";

test("a component the compiler refuses warns, naming the component and the rule", async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(["Bailout.tsx"], [
    compiler.plugin,
  ]);

  expect(compiler.taken()).toEqual([
    `Module "${at("Bailout.tsx")}" line 3: React Compiler skipped component "Bailout" — ${MUTATION}. It renders as written, without automatic memoization.`,
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

test("a component opting out that breaks a rule is not warned about, and one beside it that does not opt out is", async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(["OptedOutBailout.tsx"], [
    compiler.plugin,
  ]);

  expect(compiler.taken()).toEqual([
    `Module "${at("OptedOutBailout.tsx")}" line 8: React Compiler skipped component "Unmarked" — ${MUTATION}. It renders as written, without automatic memoization.`,
  ]);
  expect(warnings).toEqual([]);
  expect(code).not.toMatch(MEMO_CACHE_INIT);
}, 60_000);

test('a module opting out with "use no memo" is not warned about', async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(["ModuleOptedOut.tsx"], [
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

test("a bailout after non-ASCII text is reported at its own line and component", async () => {
  const compiler = compileIslands();
  await clientBuild(["Accented.tsx"], [compiler.plugin]);

  expect(compiler.taken()).toEqual([
    `Module "${at("Accented.tsx")}" line 4: React Compiler skipped component "Accented" — ${MUTATION}. It renders as written, without automatic memoization.`,
  ]);
}, 60_000);

// Through the guarded door the client build uses, which is what keeps the class.
test("a module the compiler cannot parse fails the build, naming the module and each line", async () => {
  const compiler = compileIslands();
  const failure = await clientBuild(["Broken.tsx"], [], [compiler.plugin]).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toBe(
    `Module "${at("Broken.tsx")}": React Compiler stopped on 1 fatal diagnostic and produced no code — correct each line below, then build again:\n  line 3: Expected \`:\` but found \`<\``,
  );
  await expect(workersLeft()).resolves.toEqual([]);
}, 60_000);

test("a module that crashes the compiler's process is left as written, warned about, and the next module still compiles", async () => {
  const compiler = compileIslands();
  const { code, warnings } = await clientBuild(
    ["UsesCrash.tsx"],
    [compiler.plugin],
  );

  expect(compiler.taken()).toEqual([
    `Module "${at("Crash.jsx")}": React Compiler crashed — its process exited on SIGSEGV while compiling the module. That is a fault in the compiler rather than a rule a component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash happens whether or not the directive is present. The module renders as written, without automatic memoization.`,
  ]);
  expect(warnings).toEqual([]);
  expect(code).toContain("marker-crash-2b7e");
  expect(count(code, MEMO_CACHE_INIT)).toBe(1);
  await expect(workersLeft()).resolves.toEqual([]);
}, 60_000);

// Rolldown's own runtime helper goes through the plugin too, so it is timed out
// beside the island.
test("a module past the time limit is left as written and warned about", async () => {
  const compiler = compileIslands({ moduleTimeLimitMs: 1 });
  const { code } = await clientBuild(["Counter.tsx"], [compiler.plugin]);

  expect(compiler.taken()).toContain(
    `Module "${at("Counter.tsx")}": React Compiler crashed — its process ran past 0.001 s while compiling the module. That is a fault in the compiler rather than a rule a component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash happens whether or not the directive is present. The module renders as written, without automatic memoization.`,
  );
  expect(code).not.toMatch(MEMO_CACHE_INIT);
  await expect(workersLeft()).resolves.toEqual([]);
}, 60_000);

test("no compiler process outlives a build", async () => {
  await clientBuild(["Counter.tsx"], [compileIslands().plugin]);

  await expect(workersLeft()).resolves.toEqual([]);
}, 60_000);

test("no compiler process outlives a build another plugin fails", async () => {
  const failing: Plugin = {
    name: "pagedeck:test-fails",
    buildEnd() {
      throw new Error("marker-fail-91c4");
    },
  };
  await expect(
    clientBuild(["Counter.tsx"], [compileIslands().plugin, failing]),
  ).rejects.toThrow("marker-fail-91c4");

  await expect(workersLeft()).resolves.toEqual([]);
}, 60_000);

// Spawned from `dist`, because Node cannot follow this file's `.js` specifiers
// to `.ts`: a process that compiles once and never ends a build must still exit.
test("an idle compiler process does not keep its parent alive", async () => {
  const script = `${FIXTURE_DIR}idle.mjs`;
  writeFileSync(
    script,
    [
      `import { compileIslands } from ${JSON.stringify(join(import.meta.dirname, "..", "dist", "react-compiler.js"))};`,
      `const { plugin } = compileIslands();`,
      `const out = await plugin.transform.call({}, ${JSON.stringify(COMPILABLE)}, "/site/src/Widget.jsx");`,
      `console.log(out === null ? "null" : "compiled");`,
      "",
    ].join("\n"),
  );

  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    timeout: 30_000,
  });

  expect(stdout.trim()).toBe("compiled");
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
  const { plugin } = compileIslands();
  const { transform, buildEnd } = plugin;
  if (typeof transform !== "function" || typeof buildEnd !== "function") {
    throw new Error("compileIslands no longer has plain transform and buildEnd hooks");
  }
  const result: unknown = transform.call({} as never, COMPILABLE, id, undefined);
  if (result instanceof Promise) {
    return result.finally(() => buildEnd.call({} as never, undefined));
  }
  return result;
}

test.each([
  "/site/node_modules/.pnpm/react@19.2.8/node_modules/react/cjs/react.production.js",
  "/site/node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/cjs/react-dom-client.production.js",
  "/site/node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.production.js",
  "/site/node_modules/react/cjs/react.production.js",
  "/site/node_modules/react-dom/cjs/react-dom-client.production.js",
  "/site/node_modules/scheduler/cjs/scheduler.production.js",
  "C:\\site\\node_modules\\react-dom\\cjs\\react-dom-client.production.js",
])("React's own runtime module %s passes through untransformed", (id) => {
  expect(transformed(id)).toBeNull();
});

// Vite's own JSX transform reads only `.jsx` and `.tsx`, so a whole build of a
// `.js` island is the site's `oxc.include` to arrange; here the compiler takes it.
test.each(["/site/src/Widget.js", "/site/src/Widget.mjs", "/site/src/Widget.cjs"])(
  "a %s module holding JSX compiles",
  async (id) => {
    const result = (await transformed(id)) as { code: string };

    expect(result.code).toMatch(MEMO_CACHE_INIT);
  },
);

test.each([
  "/site/node_modules/.pnpm/react-aria@3.0.0/node_modules/react-aria/dist/index.jsx",
  "/site/node_modules/react-dom-extra/index.jsx",
  "/site/node_modules/@scope/react/index.jsx",
  "/site/node_modules/react/node_modules/vendor-widget/index.jsx",
  "/site/src/react/Widget.tsx",
])("a module of another package, %s, is still compiled", async (id) => {
  const result = (await transformed(id)) as { code: string };

  expect(result.code).toMatch(MEMO_CACHE_INIT);
});
