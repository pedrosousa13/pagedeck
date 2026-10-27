import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, test } from "vitest";
import {
  installClientReferences,
  recordImporters,
} from "./client-reference-loader.js";
import { ConfigError } from "./exit.js";
import { CLIENT_REFERENCE_TARGET } from "./tree.js";

const SITES = join(import.meta.dirname, "..", "node_modules");

const execFileAsync = promisify(execFile);

const LOADER = pathToFileURL(
  join(import.meta.dirname, "..", "dist", "client-reference-loader.js"),
).href;

// Loaded before the importers are recorded, as a program that calls core
// without `bin.ts` loads its config.
const UNRECORDED = join(SITES, ".pagedeck-loader-test-unrecorded");
rmSync(UNRECORDED, { recursive: true, force: true });
mkdirSync(UNRECORDED, { recursive: true });
writeFileSync(
  join(UNRECORDED, "Early.js"),
  `"use client";\nexport default function Early() { return null; }\n`,
);
await import(/* @vite-ignore */ pathToFileURL(join(UNRECORDED, "Early.js")).href);

recordImporters();

afterAll(() => {
  rmSync(UNRECORDED, { recursive: true, force: true });
});

const CONFIG = join(SITES, "pagedeck.config.ts");

function install(
  input: Omit<Parameters<typeof installClientReferences>[0], "config"> & {
    config?: string;
  },
) {
  return installClientReferences({ config: CONFIG, ...input });
}

// Stands in for pagedeck.config.ts importing each module at top level.
async function loadThroughConfig(dir: string, ...files: string[]): Promise<string> {
  const config = join(dir, "config.js");
  writeFileSync(
    config,
    files.map((file) => `import ${JSON.stringify(pathToFileURL(file).href)};\n`).join(""),
  );
  await import(/* @vite-ignore */ pathToFileURL(config).href);
  return config;
}

// A directory per call: Node caches a module by URL for the life of the process, and
// these tests are about that cache.
let count = 0;
const written: string[] = [];

function boundary(source: string): string {
  count += 1;
  const dir = join(SITES, `.pagedeck-loader-test-${String(count)}`);
  written.push(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "Copy.js");
  writeFileSync(file, source);
  return file;
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const registry = { Copy: { import: () => Promise.resolve({}) } };

test("a boundary module the config loaded before the install fails the build, naming it", async () => {
  const file = boundary(`export default function Copy() { return null; }\n`);
  const config = await loadThroughConfig(dirname(file), file);

  const refusal = await refusalOf({
    clientComponents: { [file]: "Copy" },
    registry,
    config,
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  expect((refusal as Error).message).toContain(
    'module carrying "use client" was already loaded before the build could stand in for it',
  );
  expect((refusal as Error).message).toContain('"Copy"');
  expect((refusal as Error).message).toContain(`"${file}"`);
  expect((refusal as Error).message).toContain(
    "drop the top-level import of it from pagedeck.config.ts",
  );
  expect((refusal as Error).message).not.toContain("file://");
});

test("a second install over a module the first one proxied is not refused", async () => {
  const file = boundary(`export default function Copy() { return null; }\n`);
  const clientComponents = { [file]: "Copy" };

  const first = await install({ clientComponents, registry });
  first.close();

  const second = await install({ clientComponents, registry });
  try {
    const namespace = (await import(
      /* @vite-ignore */ pathToFileURL(file).href
    )) as Record<string, unknown>;

    expect(
      (namespace.default as Record<symbol, unknown>)[CLIENT_REFERENCE_TARGET],
    ).toBeTypeOf("function");
  } finally {
    second.close();
  }
});

test("a boundary module with no function exports is accepted even when cached", async () => {
  const file = boundary(`export const SIZE = 3;\n`);
  await import(/* @vite-ignore */ pathToFileURL(file).href);

  const installed = await install({
    clientComponents: { [file]: "Copy" },
    registry,
  });
  try {
    const namespace = (await import(
      /* @vite-ignore */ pathToFileURL(file).href
    )) as Record<string, unknown>;

    expect(namespace.SIZE).toBe(3);
  } finally {
    installed.close();
  }
});

test("a boundary module's non-component export is passed through unproxied", async () => {
  const file = boundary(
    `export default function Copy() { return null; }\nexport const SIZE = 3;\nexport function helper() { return "h"; }\n`,
  );

  const installed = await install({
    clientComponents: { [file]: "Copy" },
    registry,
  });
  try {
    const namespace = (await import(
      /* @vite-ignore */ pathToFileURL(file).href
    )) as Record<string, unknown>;

    expect(namespace.SIZE).toBe(3);
    for (const key of ["default", "helper"]) {
      expect(
        (namespace[key] as Record<symbol, unknown>)[CLIENT_REFERENCE_TARGET],
      ).toBeTypeOf("function");
    }
  } finally {
    installed.close();
  }
});

test("closing an installation, and refusing a build, both leave the factory slot as they found it", async () => {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const FACTORY = Symbol.for("@pagedeck/core client reference factory");
  expect(FACTORY in slots).toBe(false);

  const clean = boundary(`export default function Copy() { return null; }\n`);
  const installed = await install({
    clientComponents: { [clean]: "Copy" },
    registry,
  });
  expect(slots[FACTORY]).toBeTypeOf("function");
  installed.close();
  expect(FACTORY in slots).toBe(false);

  const cached = boundary(`export default function Copy() { return null; }\n`);
  await import(/* @vite-ignore */ pathToFileURL(cached).href);
  await expect(
    install({
      clientComponents: { [cached]: "Copy" },
      registry,
    }),
  ).rejects.toBeInstanceOf(ConfigError);
  expect(FACTORY in slots).toBe(false);
});

function directory(files: Readonly<Record<string, string>>): string {
  count += 1;
  const dir = join(SITES, `.pagedeck-loader-test-${String(count)}`);
  written.push(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

async function namespaceOf(file: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
}

const proxiedTarget = (value: unknown): unknown =>
  (value as Record<symbol, unknown>)[CLIENT_REFERENCE_TARGET];

async function refusalOf(input: Parameters<typeof install>[0]) {
  return install(input).then(
    (installed) => {
      installed.close();
      return undefined;
    },
    (error: unknown) => error,
  );
}

test("a boundary module another boundary module imports is proxied for both", async () => {
  const dir = directory({
    "A.js": `"use client";\nimport B from "./B.js";\nexport default function A() { return B; }\n`,
    "B.js": `"use client";\nexport default function B() { return null; }\n`,
  });
  const a = join(dir, "A.js");
  const b = join(dir, "B.js");

  const installed = await install({
    clientComponents: { [a]: "A", [b]: "B" },
    registry: { A: registry.Copy, B: registry.Copy },
  });
  try {
    const first = await namespaceOf(a);
    const second = await namespaceOf(b);
    expect(proxiedTarget(first.default)).toBeTypeOf("function");
    expect(proxiedTarget(second.default)).toBeTypeOf("function");
    const inner = (proxiedTarget(first.default) as () => unknown)();
    expect(inner).toBe(second.default);
  } finally {
    installed.close();
  }
});

test("each export is proxied by its declaration, and a non-function one proxied by mistake still renders", async () => {
  const dir = directory({
    "parts.js": `import { createElement, memo } from "react";\nexport const Wrapped = memo(function Wrapped() { return createElement("i", null, "memo"); });\n`,
    "Kinds.js": [
      `"use client";`,
      `import { Wrapped } from "./parts.js";`,
      `export const X = () => "x";`,
      `export function Y() { return "y"; }`,
      `const Z = function () { return "z"; };`,
      `export { Z as default, Wrapped };`,
      `export const SIZE = 3;`,
      `export let count = 1;`,
      `export function bump() { count += 1; }`,
      "",
    ].join("\n"),
  });
  const file = join(dir, "Kinds.js");

  const installed = await install({
    clientComponents: { [file]: "Kinds" },
    registry: { Kinds: registry.Copy },
  });
  try {
    const namespace = await namespaceOf(file);
    for (const key of ["X", "Y", "default", "bump"]) {
      expect(proxiedTarget(namespace[key]), key).toBeTypeOf("function");
    }
    expect((proxiedTarget(namespace.default) as () => string)()).toBe("z");
    expect(namespace.SIZE).toBe(3);

    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(
      renderToStaticMarkup(createElement(namespace.Wrapped as never)),
    ).toBe("<i>memo</i>");

    (proxiedTarget(namespace.bump) as () => void)();
    expect(namespace.count).toBe(2);
  } finally {
    installed.close();
  }
});

test("a boundary module's relative export * is read through, and its names proxied", async () => {
  const dir = directory({
    "impl.js": `export function Panel() { return "panel"; }\nexport const LIMIT = 4;\nexport default function Hidden() { return null; }\n`,
    "Barrel.js": `"use client";\nexport * from "./impl.js";\n`,
  });
  const file = join(dir, "Barrel.js");

  const installed = await install({
    clientComponents: { [file]: "Barrel" },
    registry: { Barrel: registry.Copy },
  });
  try {
    const namespace = await namespaceOf(file);
    expect(Object.keys(namespace).sort()).toEqual(["LIMIT", "Panel"]);
    expect(proxiedTarget(namespace.Panel)).toBeTypeOf("function");
    expect(namespace.LIMIT).toBe(4);
  } finally {
    installed.close();
  }
});

test("a boundary module whose export * names a package is refused, naming the module and the line", async () => {
  const dir = directory({
    "Barrel.js": `"use client";\nexport function Own() { return null; }\nexport * from "react";\n`,
  });
  const file = join(dir, "Barrel.js");

  const refusal = await refusalOf({
    clientComponents: { [file]: "Barrel" },
    registry: { Barrel: registry.Copy },
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  expect((refusal as Error).message).toMatch(
    new RegExp(`^Island loader: module "${file.replaceAll("/", "\\/")}" line 3: `),
  );
  expect((refusal as Error).message).toContain('export * from "react"');
});

test("a boundary module loaded before the install through another one is refused naming that importer, not the config", async () => {
  const dir = directory({
    "A.js": `"use client";\nimport B from "./B.js";\nexport default function A() { return B; }\n`,
    "B.js": `"use client";\nexport default function B() { return null; }\n`,
  });
  const a = join(dir, "A.js");
  const b = join(dir, "B.js");
  const config = await loadThroughConfig(dir, a);

  const refusal = await refusalOf({
    clientComponents: { [a]: "A", [b]: "B" },
    registry: { A: registry.Copy, B: registry.Copy },
    config,
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  const message = (refusal as Error).message;
  const [fromConfig, imported] = message.split("\n\n") as [string, string];
  expect(fromConfig).toContain(`  "A" — "${a}"`);
  expect(fromConfig).not.toContain(`"${b}"`);
  expect(imported).toContain(`  "B" — "${b}", imported by "A"`);
  expect(imported).not.toContain("pagedeck.config.ts");
});

test("a boundary module loaded through a module that is not registered is refused naming that module", async () => {
  const dir = directory({
    "A.js": `"use client";\nimport { inner } from "./helper.js";\nexport default function A() { return inner; }\n`,
    "helper.js": `import B from "./B.js";\nexport const inner = B;\n`,
    "B.js": `"use client";\nexport default function B() { return null; }\n`,
  });
  const a = join(dir, "A.js");
  const b = join(dir, "B.js");
  const config = await loadThroughConfig(dir, a);

  const refusal = await refusalOf({
    clientComponents: { [a]: "A", [b]: "B" },
    registry: { A: registry.Copy, B: registry.Copy },
    config,
  });

  const [, imported] = (refusal as Error).message.split("\n\n") as [
    string,
    string,
  ];
  expect(imported).toContain(
    `  "B" — "${b}", imported by "${join(dir, "helper.js")}"`,
  );
  expect(imported).not.toContain("pagedeck.config.ts");
});

test("destructured exports are each proxied, by what they hold once loaded", async () => {
  const dir = directory({
    "Pairs.js": [
      `"use client";`,
      `const parts = { Left: () => "l", size: 2 };`,
      `export const { Left, size } = parts;`,
      `export const [First, , ...others] = [() => "f", 0, 1];`,
      "",
    ].join("\n"),
  });
  const file = join(dir, "Pairs.js");

  const installed = await install({
    clientComponents: { [file]: "Pairs" },
    registry: { Pairs: registry.Copy },
  });
  try {
    const namespace = await namespaceOf(file);
    expect(Object.keys(namespace).sort()).toEqual([
      "First",
      "Left",
      "others",
      "size",
    ]);
    expect(proxiedTarget(namespace.Left)).toBeTypeOf("function");
    expect(proxiedTarget(namespace.First)).toBeTypeOf("function");
    expect(namespace.size).toBe(2);
    expect(namespace.others).toEqual([1]);
  } finally {
    installed.close();
  }
});

test("a name two export * statements bind differently is left out, as ESM leaves it out, and one they share is kept", async () => {
  const dir = directory({
    "shared.js": `export function Shared() { return "s"; }\n`,
    "left.js": `export function Clash() { return "l"; }\nexport { Shared } from "./shared.js";\n`,
    "right.js": `export function Clash() { return "r"; }\nexport * from "./shared.js";\n`,
    "Barrel.js": `"use client";\nexport * from "./left.js";\nexport * from "./right.js";\n`,
  });
  const file = join(dir, "Barrel.js");

  const installed = await install({
    clientComponents: { [file]: "Barrel" },
    registry: { Barrel: registry.Copy },
  });
  try {
    const namespace = await namespaceOf(file);
    expect(Object.keys(namespace)).toEqual(["Shared"]);
    expect(proxiedTarget(namespace.Shared)).toBeTypeOf("function");
  } finally {
    installed.close();
  }
});

test("a CommonJS boundary module is read by running it, as before", async () => {
  const dir = directory({
    "package.json": `${JSON.stringify({ type: "commonjs" })}\n`,
    "Panel.js": `"use client";\nexports.Panel = function Panel() { return "p"; };\nexports.LIMIT = 4;\n`,
    "Copy.cjs": `"use client";\nmodule.exports = function Copy() { return "c"; };\n`,
  });
  const panel = join(dir, "Panel.js");
  const copy = join(dir, "Copy.cjs");

  const installed = await install({
    clientComponents: { [panel]: "Panel", [copy]: "Copy" },
    registry: { Panel: registry.Copy, Copy: registry.Copy },
  });
  try {
    const panels = await namespaceOf(panel);
    expect(proxiedTarget(panels.Panel)).toBeTypeOf("function");
    expect(panels.LIMIT).toBe(4);
    const copies = await namespaceOf(copy);
    expect(proxiedTarget(copies.default)).toBeTypeOf("function");
  } finally {
    installed.close();
  }
});

test("a boundary module that does not parse is refused, naming the module and quoting the parser's frame", async () => {
  const dir = directory({
    "Broken.js": `"use client";\nexport default function Broken( {\n`,
  });
  const file = join(dir, "Broken.js");

  const refusal = await refusalOf({
    clientComponents: { [file]: "Broken" },
    registry: { Broken: registry.Copy },
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  const message = (refusal as Error).message;
  expect(message.startsWith(`Island loader: module "${file}": does not parse`)).toBe(true);
  expect(message).toContain(`\n    x Expected`);
  expect(message).toContain(`,-[${file}:`);
});

test("faults in two modules are reported together, counting modules, not faults", async () => {
  const dir = directory({
    "Broken.js": `"use client";\nexport default function Broken( {\n`,
    "Barrel.js": `"use client";\nexport * from "react";\nexport * from "react-dom";\n`,
  });
  const broken = join(dir, "Broken.js");
  const barrel = join(dir, "Barrel.js");

  const refusal = await refusalOf({
    clientComponents: { [broken]: "Broken", [barrel]: "Barrel" },
    registry: { Broken: registry.Copy, Barrel: registry.Copy },
  });

  const message = (refusal as Error).message;
  expect(message).toMatch(/^Island loader: 3 faults in 2 modules /);
  expect(message).toContain(`  module "${barrel}" line 2: `);
  expect(message).toContain(`  module "${barrel}" line 3: `);
  expect(message).toContain(`  module "${broken}": does not parse`);
});

// Spawned: Vitest runs a `.js` module from a package with no "type" through its own
// transform rather than Node's loader, and these are about Node's detection.
async function inNode(script: string): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { installClientReferences } from ${JSON.stringify(LOADER)};\n${script}`,
  ]);
  return JSON.parse(stdout) as unknown;
}

test("a .cjs module, and a .js one in a package with no type, with a top-level return are read by running them, as Node runs them", async () => {
  const dir = directory({
    "package.json": "{}\n",
    "Guarded.cjs": `"use client";\nif (typeof module === "undefined") return;\nmodule.exports = function Guarded() { return "g"; };\n`,
    "Loose.js": `"use client";\nif (typeof module === "undefined") return;\nexports.Loose = function Loose() { return "l"; };\n`,
  });
  const guarded = join(dir, "Guarded.cjs");
  const loose = join(dir, "Loose.js");
  const target = `Symbol.for(${JSON.stringify(CLIENT_REFERENCE_TARGET.description)})`;

  const proxied = await inNode(`
const installed = await installClientReferences({
  clientComponents: { ${JSON.stringify(guarded)}: "Guarded", ${JSON.stringify(loose)}: "Loose" },
  registry: { Guarded: {}, Loose: {} },
  config: ${JSON.stringify(CONFIG)},
});
const guarded = await import(${JSON.stringify(pathToFileURL(guarded).href)});
const loose = await import(${JSON.stringify(pathToFileURL(loose).href)});
installed.close();
console.log(JSON.stringify([typeof guarded.default[${target}], typeof loose.Loose[${target}]]));
`);

  expect(proxied).toEqual(["function", "function"]);
}, 30_000);

test("a .js boundary module whose only module syntax is top-level await or import.meta is read without running it", async () => {
  const dir = directory({
    "package.json": "{}\n",
    "A.js": `"use client";\nglobalThis.pagedeckOrder.push("A");\nexport default function A() { return null; }\n`,
    "Meta.js": `"use client";\nglobalThis.pagedeckOrder.push(import.meta.url.includes("/Meta.js") ? "meta" : "?");\n`,
    "Wait.js": `"use client";\nawait Promise.resolve();\nglobalThis.pagedeckOrder.push("wait");\n`,
  });
  const files = ["A.js", "Meta.js", "Wait.js"].map((name) => join(dir, name));

  const order = await inNode(`
globalThis.pagedeckOrder = [];
const installed = await installClientReferences({
  clientComponents: ${JSON.stringify(Object.fromEntries(files.map((file, at) => [file, `Module${String(at)}`])))},
  registry: ${JSON.stringify(Object.fromEntries(files.map((_, at) => [`Module${String(at)}`, {}])))},
  config: ${JSON.stringify(CONFIG)},
});
installed.close();
console.log(JSON.stringify(globalThis.pagedeckOrder));
`);

  expect(order).toEqual(["A", "meta", "wait"]);
}, 30_000);

test("a boundary module loaded before anything recorded its importer is refused with a fix to look for", async () => {
  const early = join(UNRECORDED, "Early.js");

  const refusal = await refusalOf({
    clientComponents: { [early]: "Early" },
    registry: { Early: registry.Copy },
  });

  const message = (refusal as Error).message;
  expect(message).toContain(`  "Early" — "${early}"`);
  expect(message).toContain(
    "find the module that imports each at top level, most likely pagedeck.config.ts or a module it imports, and load that module only through a registry thunk",
  );
});

test("a boundary module a CommonJS boundary module requires is refused, naming the CommonJS importer and its fix", async () => {
  const dir = directory({
    "A.cjs": `"use client";\nconst B = require("./B.mjs");\nmodule.exports = function A() { return B; };\n`,
    "B.mjs": `"use client";\nexport default function B() { return null; }\n`,
  });
  const a = join(dir, "A.cjs");
  const b = join(dir, "B.mjs");

  const refusal = await refusalOf({
    clientComponents: { [a]: "A", [b]: "B" },
    registry: { A: registry.Copy, B: registry.Copy },
  });

  const message = (refusal as Error).message;
  expect(message).toContain(`  "B" — "${b}", required by "A"`);
  expect(message).toContain(
    "make the importer named beside each an ES module, or drop the module it requires from build.components",
  );
  expect(message).not.toContain("pagedeck.config.ts");
});

test("a boundary module whose export * reaches a CommonJS module is refused, naming the module and the line", async () => {
  const dir = directory({
    "impl.cjs": `exports.Panel = function Panel() { return null; };\n`,
    "Barrel.js": `"use client";\nexport * from "./impl.cjs";\n`,
  });
  const file = join(dir, "Barrel.js");

  const refusal = await refusalOf({
    clientComponents: { [file]: "Barrel" },
    registry: { Barrel: registry.Copy },
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  expect((refusal as Error).message).toBe(
    `Island loader: module "${file}" line 2: export * from "./impl.cjs" reaches a CommonJS module, and the build reads the names a "use client" module re-exports without running them — re-export each name instead, as export { Name } from "./impl.cjs"`,
  );
});
