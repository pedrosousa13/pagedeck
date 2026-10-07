import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { LoadFnOutput, LoadHookContext } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { ConfigError, describeError } from "./exit.js";
import { jsxLoad } from "./jsx-loader.js";

const execFileAsync = promisify(execFile);

const CONTEXT: LoadHookContext = {
  conditions: ["node", "import"],
  format: undefined,
  importAttributes: {},
};

const ISLAND = `"use client";
import { useState } from "react";

interface Props {
  label: string;
}

export default function Counter({ label }: Props) {
  const [count, setCount] = useState<number>(0);
  return <button onClick={() => setCount(count + 1)}>{label} {count}</button>;
}
`;

function served(source: string): {
  calls: { url: string; context: Partial<LoadHookContext> | undefined }[];
  nextLoad: (url: string, context?: Partial<LoadHookContext>) => LoadFnOutput;
} {
  const calls: {
    url: string;
    context: Partial<LoadHookContext> | undefined;
  }[] = [];
  return {
    calls,
    nextLoad: (url, context) => {
      calls.push({ url, context });
      return { format: context?.format, source };
    },
  };
}

test("a site's .tsx module is compiled with React's automatic runtime, its types stripped and its directive kept first", () => {
  const { nextLoad } = served(ISLAND);
  const loaded = jsxLoad(
    "file:///site/components/Counter.tsx",
    CONTEXT,
    nextLoad,
  );

  expect(loaded.format).toBe("module");
  expect(loaded.shortCircuit).toBe(true);
  const source = String(loaded.source);
  expect(source.startsWith('"use client";\n')).toBe(true);
  expect(source).toContain('from "react/jsx-runtime"');
  expect(source).not.toContain("interface");
  expect(source).not.toContain("<button");
  expect(source).not.toContain("useState<number>");
});

test("a site's .jsx module is compiled too", () => {
  const { nextLoad } = served(
    `export default function Note() {\n  return <p>marker-note-1b6e</p>;\n}\n`,
  );
  const source = String(
    jsxLoad("file:///site/components/Note.jsx", CONTEXT, nextLoad).source,
  );

  expect(source).toContain('from "react/jsx-runtime"');
  expect(source).not.toContain("<p>");
});

test("a module asked for under a query is compiled by its path", () => {
  const { nextLoad, calls } = served(ISLAND);
  const url = "file:///site/components/Counter.tsx?fw-client-original";
  const source = String(jsxLoad(url, CONTEXT, nextLoad).source);

  expect(source).toContain('from "react/jsx-runtime"');
  expect(calls.map((call) => call.url)).toEqual([url]);
});

test("a .tsx module under node_modules is handed on untouched", () => {
  const { nextLoad, calls } = served(ISLAND);
  const url = "file:///site/node_modules/widgets/Counter.tsx";
  const loaded = jsxLoad(url, CONTEXT, nextLoad);

  expect(calls).toEqual([{ url, context: CONTEXT }]);
  expect(loaded.source).toBe(ISLAND);
});

test("a module that is not .tsx or .jsx is handed on untouched", () => {
  for (const url of [
    "file:///site/pagedeck.config.ts",
    "file:///site/components/Plain.js",
    "node:fs",
  ]) {
    const { nextLoad, calls } = served("export {};\n");
    jsxLoad(url, CONTEXT, nextLoad);
    expect(calls).toEqual([{ url, context: CONTEXT }]);
  }
});

test("a syntax error is a config error naming the module and the line, caused by the compiler's report", () => {
  const { nextLoad } = served(
    `export default function Bad() {\n  return <p>{x</p>;\n}\n`,
  );
  let thrown: unknown;
  try {
    jsxLoad("file:///site/components/Bad.tsx", CONTEXT, nextLoad);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ConfigError);
  expect(describeError(thrown)).toBe(
    'Module "/site/components/Bad.tsx" line 2: does not compile — fix the syntax at the line named: column 16: Unterminated regular expression',
  );
  const cause = (thrown as Error).cause as AggregateError;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause.errors).toHaveLength(1);
  expect((cause.errors[0] as { loc: unknown }).loc).toEqual({
    line: 2,
    column: 15,
    file: "/site/components/Bad.tsx",
  });
});

test("every syntax error in a module is named, in source order", () => {
  const { nextLoad } = served(
    `export const C = () => <div/>;\nconst y: number = 1;\n`,
  );
  let thrown: unknown;
  try {
    jsxLoad("file:///site/components/Typed.jsx", CONTEXT, nextLoad);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ConfigError);
  expect(describeError(thrown)).toBe(
    'Module "/site/components/Typed.jsx": 2 syntax errors, so it does not compile — fix the syntax at each line named: line 2, column 7: Missing initializer in const declaration; line 2, column 8: Expected a semicolon or an implicit semicolon after a statement, but found none',
  );
  expect(((thrown as Error).cause as AggregateError).errors).toHaveLength(2);
});

// Spawned against `dist`: under Vitest every `import()` in this package is Vitest's.
const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-jsx-loader");
const LOADER = pathToFileURL(
  join(import.meta.dirname, "..", "dist", "jsx-loader.js"),
).href;

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("a component's runtime error points at its .tsx line, not the compiled one", async () => {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  const component = join(SITE, "Boom.tsx");
  writeFileSync(
    component,
    `interface Props {
  armed: boolean;
}

export default function Boom({ armed }: Props) {
  if (armed) {
    throw new Error("marker-boom-5c19");
  }
  return <p>quiet</p>;
}
`,
  );
  const script = `import { installJsxLoader } from ${JSON.stringify(LOADER)};
installJsxLoader();
const { default: Boom } = await import(${JSON.stringify(pathToFileURL(component).href)});
try { Boom({ armed: true }); } catch (error) { console.log(error.stack); }
`;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: SITE },
  );

  expect(stdout).toContain("marker-boom-5c19");
  expect(stdout).toContain(`${component}:7:11`);
}, 60_000);
