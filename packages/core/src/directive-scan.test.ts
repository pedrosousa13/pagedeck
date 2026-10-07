// The fixture is written at test time: one module carries `"use server"`, a build
// failure by design, which would trap any later scan over this repo.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";
import { inProductionEnv } from "./client-build.js";
import { recordIslandBoundaries } from "./directive-scan.js";
import { resolveBoundaries } from "./directives.js";
import type { BoundarySet, ModuleGraph } from "./directives.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-boundary-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const OUT = `${FIXTURE_DIR}dist/`;
const DEP = `${FIXTURE_DIR}node_modules/design-system/`;

function at(file: string): string {
  return `${SRC}${file}`;
}

const FIXTURE: Record<string, string> = {
  "Shared.ts": `export const SHARED = "marker-shared-8f2a";\n`,

  "Static.tsx": [
    `import { SHARED } from "./Shared.js";`,
    `const label: string = "marker-static-31c7";`,
    `export default function Static() { return label + SHARED; }`,
    "",
  ].join("\n"),

  "Counter.tsx": [
    `"use client";`,
    `import { SHARED } from "./Shared.js";`,
    `const label: string = "marker-counter-a904";`,
    `export default function Counter() { return label + SHARED; }`,
    "",
  ].join("\n"),

  "Tooltip.tsx": [
    `"use client";`,
    `export default function Tooltip() { return "marker-tooltip-5d10"; }`,
    "",
  ].join("\n"),
  "Passthrough.ts": [
    `import Tooltip from "./Tooltip.js";`,
    `export const wrapped = Tooltip;`,
    "",
  ].join("\n"),
  "Panel.tsx": [
    `import { wrapped } from "./Passthrough.js";`,
    `export default function Panel() { return wrapped(); }`,
    "",
  ].join("\n"),

  "actions.ts": [
    `"use server";`,
    `export async function save() { return "marker-actions-7b31"; }`,
    "",
  ].join("\n"),
  "Form.tsx": [
    `import { save } from "./actions.js";`,
    `export default function Form() { return save; }`,
    "",
  ].join("\n"),

  "Aside.tsx": [
    `import { wrapped } from "./Passthrough.js";`,
    `export default function Aside() { return wrapped(); }`,
    "",
  ].join("\n"),

  "Page.tsx": [
    `import { Badge } from "design-system";`,
    `export default function Page() { return Badge(); }`,
    "",
  ].join("\n"),
  "Submit.tsx": [
    `import { save } from "design-system/actions";`,
    `export default function Submit() { return save; }`,
    "",
  ].join("\n"),

  "Conditional.tsx": [
    `import { Chip } from "design-system/conditional";`,
    `export default function Conditional() { return Chip(); }`,
    "",
  ].join("\n"),
};

const DEPENDENCY: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "design-system",
    version: "1.0.0",
    type: "module",
    exports: {
      ".": "./index.js",
      "./actions": "./actions.js",
      // One specifier, two files split by export condition, differing on `"use client"`: a
      // scan under the wrong condition reads a file the client build never bundles.
      "./conditional": {
        production: "./conditional.production.js",
        development: "./conditional.development.js",
      },
    },
  }),
  "index.js": [
    `"use client";`,
    `export function Badge() { return "marker-badge-c62f"; }`,
    "",
  ].join("\n"),
  "actions.js": [
    `"use server";`,
    `export async function save() { return "marker-dep-save-1e44"; }`,
    "",
  ].join("\n"),
  "conditional.production.js": [
    `"use client";`,
    `export function Chip() { return "marker-chip-prod-9a15"; }`,
    "",
  ].join("\n"),
  "conditional.development.js": [
    `export function Chip() { return "marker-chip-dev-4c07"; }`,
    "",
  ].join("\n"),
};

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  for (const [file, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${file}`, source);
  }
  mkdirSync(DEP, { recursive: true });
  for (const [file, source] of Object.entries(DEPENDENCY)) {
    writeFileSync(`${DEP}${file}`, source);
  }
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function chunksOf(
  result: Awaited<ReturnType<typeof build>>,
): { fileName: string; code: string; modules: readonly string[] }[] {
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((one) =>
    "output" in one
      ? one.output
          .filter((emitted) => emitted.type === "chunk")
          .map((chunk) => ({
            fileName: chunk.fileName,
            code: chunk.code,
            modules: Object.keys(chunk.modules),
          }))
      : [],
  );
}

const PRODUCTION_PINS = {
  envDir: false,
  mode: "production",
  define: { "process.env.NODE_ENV": '"production"' },
  oxc: { jsx: { runtime: "automatic", development: false } },
} as const;

// Wrapped in `inProductionEnv`: Vitest sets `NODE_ENV=test`, and `mode` alone does not
// move Vite's `isProduction`, which picks the export condition (#107).
async function serverBuild(entries: readonly string[]): Promise<{
  boundaries: BoundarySet;
  chunks: ReturnType<typeof chunksOf>;
}> {
  let recorded: ModuleGraph | undefined;
  const result = await inProductionEnv(async () =>
    build({
      configFile: false,
      logLevel: "warn",
      ...PRODUCTION_PINS,
      root: FIXTURE_DIR,
      build: {
        ssr: true,
        outDir: OUT,
        write: false,
        minify: false,
        rollupOptions: {
          input: entries.map(at),
          output: { format: "esm" },
        },
      },
      plugins: [
        recordIslandBoundaries((graph) => {
          recorded = graph;
        }).plugin,
      ],
    }),
  );
  if (recorded === undefined) {
    throw new Error("the scan never reported a module graph");
  }
  return { boundaries: resolveBoundaries(recorded), chunks: chunksOf(result) };
}

test("the scan resolves a dependency under the production export condition", async () => {
  const { boundaries } = await serverBuild(["Conditional.tsx"]);

  expect(boundaries.boundaries.map((one) => one.module)).toEqual([
    `${DEP}conditional.production.js`,
  ]);
}, 60_000);

test('a "use client" component is a boundary and a directive-less one is not', async () => {
  const { boundaries } = await serverBuild(["Static.tsx", "Counter.tsx"]);

  expect(boundaries.boundaries.map((one) => one.module)).toEqual([
    at("Counter.tsx"),
  ]);
  expect(boundaries.clientModules).toContain(at("Shared.ts"));
  expect(boundaries.clientModules).not.toContain(at("Static.tsx"));
}, 60_000);

test("a boundary reached through a non-directive module is classified by the directive", async () => {
  const { boundaries } = await serverBuild(["Panel.tsx"]);

  expect(boundaries.boundaries).toEqual([
    {
      module: at("Tooltip.tsx"),
      closure: [at("Tooltip.tsx")],
      reachedBy: [at("Panel.tsx")],
    },
  ]);
  expect(boundaries.clientModules).not.toContain(at("Panel.tsx"));
  expect(boundaries.clientModules).not.toContain(at("Passthrough.ts"));
}, 60_000);

test("the directive-less component ships no JavaScript", async () => {
  const { boundaries } = await serverBuild(["Static.tsx", "Counter.tsx"]);

  const client = chunksOf(
    await inProductionEnv(async () =>
      build({
        configFile: false,
        logLevel: "warn",
        ...PRODUCTION_PINS,
        root: FIXTURE_DIR,
        build: {
          outDir: OUT,
          write: false,
          minify: false,
          rollupOptions: {
            input: boundaries.boundaries.map((one) => one.module),
            output: { format: "esm" },
            // A boundary's exports must survive: without this the browser build drops them all and
            // the assertion below passes over an empty bundle.
            preserveEntrySignatures: "strict",
          },
        },
      }),
    ),
  );
  const shipped = client.map((chunk) => chunk.code).join("\n");

  expect(shipped).toContain("marker-counter-a904");
  expect(shipped).toContain("marker-shared-8f2a");
  expect(shipped).not.toContain("marker-static-31c7");
}, 60_000);

test('a dependency\'s unused "use server" module does not fail the build', async () => {
  const { boundaries } = await serverBuild(["Page.tsx"]);

  expect(boundaries.clientModules).not.toContain(`${DEP}actions.js`);
  expect(boundaries.boundaries.map((one) => one.module)).toEqual([
    `${DEP}index.js`,
  ]);
}, 60_000);

test('a reachable "use server" module fails the build naming the file and the chain', async () => {
  await expect(serverBuild(["Form.tsx"])).rejects.toThrow(
    new RegExp(
      `1 module carrying "use server".*"${at("actions.ts")}" — ${at("Form.tsx")} → ${at("actions.ts")}`,
      "s",
    ),
  );
}, 60_000);

test("the same input graph gives the same boundary set on a second build", async () => {
  const first = await serverBuild(["Panel.tsx", "Static.tsx", "Counter.tsx"]);
  const second = await serverBuild(["Counter.tsx", "Static.tsx", "Panel.tsx"]);

  expect(second.boundaries).toEqual(first.boundaries);
  expect(first.boundaries.boundaries).toHaveLength(2);
}, 60_000);

test('a "use client" module inside a dependency is a boundary', async () => {
  const { boundaries } = await serverBuild(["Page.tsx"]);

  expect(boundaries.boundaries.map((one) => one.module)).toEqual([
    `${DEP}index.js`,
  ]);
  expect(boundaries.clientModules).toEqual([`${DEP}index.js`]);
}, 60_000);

test('a reachable "use server" module inside a dependency fails the build', async () => {
  await expect(serverBuild(["Submit.tsx"])).rejects.toThrow(
    new RegExp(
      `1 module carrying "use server".*"${DEP}actions.js" — ${at("Submit.tsx")} → ${DEP}actions.js`,
      "s",
    ),
  );
}, 60_000);

test("a site config that narrows ssr.noExternal cannot hide a boundary", async () => {
  let recorded: ModuleGraph | undefined;
  await inProductionEnv(async () =>
    build({
      configFile: false,
      logLevel: "warn",
      ...PRODUCTION_PINS,
      root: FIXTURE_DIR,
      ssr: { noExternal: ["some-other-package"] },
      build: {
        ssr: true,
        outDir: OUT,
        write: false,
        rollupOptions: { input: [at("Page.tsx")], output: { format: "esm" } },
      },
      plugins: [
        recordIslandBoundaries((graph) => {
          recorded = graph;
        }).plugin,
      ],
    }),
  );

  if (recorded === undefined) {
    throw new Error("the scan never reported a module graph");
  }
  expect(
    resolveBoundaries(recorded).boundaries.map((one) => one.module),
  ).toEqual([`${DEP}index.js`]);
}, 60_000);

test("a boundary that lands in a shared chunk is still recorded", async () => {
  const { boundaries, chunks } = await serverBuild(["Panel.tsx", "Aside.tsx"]);

  expect(boundaries.boundaries.map((one) => one.module)).toEqual([
    at("Tooltip.tsx"),
  ]);
  expect(boundaries.boundaries[0]?.reachedBy).toEqual([
    at("Aside.tsx"),
    at("Panel.tsx"),
  ]);

  const shared = chunks.find(
    (chunk) =>
      chunk.modules.includes(at("Tooltip.tsx")) &&
      !chunk.fileName.startsWith("Panel"),
  );
  expect(shared).toBeDefined();
  expect(shared?.code).toContain("marker-tooltip-5d10");
  expect(shared?.code).not.toContain("use client");
}, 60_000);
