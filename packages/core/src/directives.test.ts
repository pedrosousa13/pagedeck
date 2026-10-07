import { expect, test } from "vitest";
import { resolveBoundaries } from "./directives.js";
import type { Directive, ModuleGraph } from "./directives.js";
import { readDirective } from "./directive-source.js";
import { ConfigError } from "./exit.js";

function graphOf(shape: {
  entries: readonly string[];
  imports: Record<string, readonly string[]>;
  directives?: Record<string, Directive>;
}): ModuleGraph {
  return {
    entries: shape.entries,
    imports: new Map(Object.entries(shape.imports)),
    directives: new Map(Object.entries(shape.directives ?? {})),
  };
}

test("reads a directive at the top of the module", () => {
  expect(readDirective("/src/Tooltip.tsx", '"use client";\n')).toBe(
    "use client",
  );
});

test("reads a directive later in the prologue", () => {
  expect(
    readDirective("/src/Tooltip.tsx", '"use strict";\n"use client";\n'),
  ).toBe("use client");
});

test("reads a directive after a leading comment", () => {
  expect(
    readDirective("/src/Tooltip.tsx", '// interactive leaf\n"use client";\n'),
  ).toBe("use client");
});

test("reads a directive from a module using JSX and type annotations", () => {
  const source = [
    '"use client";',
    "const label: string = 'x';",
    "export default function Tooltip() { return <span>{label}</span>; }",
  ].join("\n");
  expect(readDirective("/src/Tooltip.tsx", source)).toBe("use client");
});

test('reads "use server"', () => {
  expect(readDirective("/src/actions.ts", '"use server";\n')).toBe(
    "use server",
  );
});

test("does not read a string after an import as a directive", () => {
  expect(
    readDirective("/src/Tooltip.tsx", 'import x from "y";\n"use client";\n'),
  ).toBeUndefined();
});

test("does not read a string inside a function as a directive", () => {
  expect(
    readDirective("/src/Tooltip.tsx", 'function f() { "use client"; }\n'),
  ).toBeUndefined();
});

test("does not read a string assigned to a binding as a directive", () => {
  expect(
    readDirective("/src/Tooltip.tsx", 'const mode = "use client";\n'),
  ).toBeUndefined();
});

test("reads no directive from a module that declares none", () => {
  expect(
    readDirective("/src/Hero.tsx", "export default function Hero() {}\n"),
  ).toBeUndefined();
});

test("refuses a module that will not parse, naming it and keeping the cause", () => {
  let thrown: unknown;
  try {
    readDirective("/src/Broken.tsx", "const = ;");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as ConfigError).message).toContain('"/src/Broken.tsx"');
  expect((thrown as ConfigError).cause).toBeDefined();
});

test("finds no boundary in a graph with no directive", () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/entry.ts"],
      imports: { "/src/entry.ts": ["/src/Hero.tsx"], "/src/Hero.tsx": [] },
    }),
  );
  expect(result.boundaries).toEqual([]);
  expect(result.clientModules).toEqual([]);
});

test("classifies by the directive, not by the entry that reaches it", () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/entry.ts"],
      imports: {
        "/src/entry.ts": ["/src/Hero.tsx"],
        "/src/Hero.tsx": ["/src/Tooltip.tsx"],
        "/src/Tooltip.tsx": ["/src/useViewport.ts"],
        "/src/useViewport.ts": [],
      },
      directives: { "/src/Tooltip.tsx": "use client" },
    }),
  );
  expect(result.boundaries).toEqual([
    {
      module: "/src/Tooltip.tsx",
      closure: ["/src/Tooltip.tsx", "/src/useViewport.ts"],
      reachedBy: ["/src/entry.ts"],
    },
  ]);
  expect(result.clientModules).toEqual([
    "/src/Tooltip.tsx",
    "/src/useViewport.ts",
  ]);
});

test("reports which entries reach each boundary", () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/a.ts", "/src/b.ts"],
      imports: {
        "/src/a.ts": ["/src/Tooltip.tsx"],
        "/src/b.ts": ["/src/Hero.tsx"],
        "/src/Hero.tsx": ["/src/Tooltip.tsx"],
        "/src/Tooltip.tsx": [],
      },
      directives: { "/src/Tooltip.tsx": "use client" },
    }),
  );
  expect(result.boundaries[0]?.reachedBy).toEqual(["/src/a.ts", "/src/b.ts"]);
});

test("names a repeated entry once in reachedBy", () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/a.ts", "/src/a.ts", "/src/b.ts"],
      imports: {
        "/src/a.ts": ["/src/Tooltip.tsx"],
        "/src/b.ts": ["/src/Tooltip.tsx"],
        "/src/Tooltip.tsx": [],
      },
      directives: { "/src/Tooltip.tsx": "use client" },
    }),
  );
  expect(result.boundaries[0]?.reachedBy).toEqual(["/src/a.ts", "/src/b.ts"]);
});

test("leaves a boundary no entry reaches out of the set", () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/entry.ts"],
      imports: {
        "/src/entry.ts": [],
        "/src/Unused.tsx": [],
      },
      directives: { "/src/Unused.tsx": "use client" },
    }),
  );
  expect(result.boundaries).toEqual([]);
});

test("terminates on a cycle", () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/entry.ts"],
      imports: {
        "/src/entry.ts": ["/src/Tooltip.tsx"],
        "/src/Tooltip.tsx": ["/src/panel.ts"],
        "/src/panel.ts": ["/src/Tooltip.tsx"],
      },
      directives: { "/src/Tooltip.tsx": "use client" },
    }),
  );
  expect(result.clientModules).toEqual(["/src/Tooltip.tsx", "/src/panel.ts"]);
});

test("returns the same set for the same graph declared in another order", () => {
  const oneWay = resolveBoundaries(
    graphOf({
      entries: ["/src/a.ts", "/src/b.ts"],
      imports: {
        "/src/a.ts": ["/src/Hero.tsx", "/src/Tooltip.tsx"],
        "/src/b.ts": ["/src/Tooltip.tsx"],
        "/src/Hero.tsx": ["/src/Panel.tsx"],
        "/src/Tooltip.tsx": ["/src/useViewport.ts"],
        "/src/Panel.tsx": ["/src/useViewport.ts"],
        "/src/useViewport.ts": [],
      },
      directives: {
        "/src/Tooltip.tsx": "use client",
        "/src/Panel.tsx": "use client",
      },
    }),
  );
  const otherWay = resolveBoundaries(
    graphOf({
      entries: ["/src/b.ts", "/src/a.ts"],
      imports: {
        "/src/useViewport.ts": [],
        "/src/Panel.tsx": ["/src/useViewport.ts"],
        "/src/Tooltip.tsx": ["/src/useViewport.ts"],
        "/src/Hero.tsx": ["/src/Panel.tsx"],
        "/src/b.ts": ["/src/Tooltip.tsx"],
        "/src/a.ts": ["/src/Tooltip.tsx", "/src/Hero.tsx"],
      },
      directives: {
        "/src/Panel.tsx": "use client",
        "/src/Tooltip.tsx": "use client",
      },
    }),
  );
  expect(otherWay).toEqual(oneWay);
});

test('passes a "use server" module no entry reaches', () => {
  const result = resolveBoundaries(
    graphOf({
      entries: ["/src/entry.ts"],
      imports: {
        "/src/entry.ts": ["/src/Hero.tsx"],
        "/src/Hero.tsx": [],
        "/pkg/actions.ts": [],
      },
      directives: { "/pkg/actions.ts": "use server" },
    }),
  );
  expect(result.boundaries).toEqual([]);
});

test('refuses a reachable "use server" module, naming it and the chain', () => {
  let thrown: unknown;
  try {
    resolveBoundaries(
      graphOf({
        entries: ["/src/entry.ts"],
        imports: {
          "/src/entry.ts": ["/src/Form.tsx"],
          "/src/Form.tsx": ["/pkg/actions.ts"],
          "/pkg/actions.ts": [],
        },
        directives: { "/pkg/actions.ts": "use server" },
      }),
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as ConfigError).message).toContain('"/pkg/actions.ts"');
  expect((thrown as ConfigError).message).toContain(
    "/src/entry.ts → /src/Form.tsx → /pkg/actions.ts",
  );
});

test('enumerates every reachable "use server" module', () => {
  let thrown: unknown;
  try {
    resolveBoundaries(
      graphOf({
        entries: ["/src/entry.ts"],
        imports: {
          "/src/entry.ts": ["/pkg/one.ts", "/pkg/two.ts"],
          "/pkg/one.ts": [],
          "/pkg/two.ts": [],
        },
        directives: {
          "/pkg/one.ts": "use server",
          "/pkg/two.ts": "use server",
        },
      }),
    );
  } catch (error) {
    thrown = error;
  }
  const message = (thrown as ConfigError).message;
  expect(message).toContain('"/pkg/one.ts"');
  expect(message).toContain('"/pkg/two.ts"');
  expect(message).toContain("2 modules");
});

test('joins the "use server" headline to its fix with one em-dash', () => {
  let thrown: unknown;
  try {
    resolveBoundaries(
      graphOf({
        entries: ["/src/entry.ts"],
        imports: { "/src/entry.ts": ["/pkg/actions.ts"] },
        directives: { "/pkg/actions.ts": "use server" },
      }),
    );
  } catch (error) {
    thrown = error;
  }
  const headline = (thrown as ConfigError).message.split("\n")[0] ?? "";
  expect([...headline].filter((character) => character === "\u2014")).toEqual([
    "\u2014",
  ]);
});
