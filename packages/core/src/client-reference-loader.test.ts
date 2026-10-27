import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { installClientReferences } from "./client-reference-loader.js";
import { ConfigError } from "./exit.js";
import { CLIENT_REFERENCE_TARGET } from "./tree.js";

const SITES = join(import.meta.dirname, "..", "node_modules");

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

test("a boundary module already loaded before the install fails the build, naming it", async () => {
  const file = boundary(`export default function Copy() { return null; }\n`);
  await import(/* @vite-ignore */ pathToFileURL(file).href);

  const refusal = await installClientReferences({
    clientComponents: { [file]: "Copy" },
    registry,
  }).then(
    (install) => {
      install.close();
      return undefined;
    },
    (error: unknown) => error,
  );

  expect(refusal).toBeInstanceOf(ConfigError);
  expect((refusal as Error).message).toContain(
    'module carrying "use client" was already loaded before the build could stand in for it',
  );
  expect((refusal as Error).message).toContain('"Copy"');
  expect((refusal as Error).message).toContain(`"${file}"`);
  expect((refusal as Error).message).not.toContain("file://");
});

test("a second install over a module the first one proxied is not refused", async () => {
  const file = boundary(`export default function Copy() { return null; }\n`);
  const clientComponents = { [file]: "Copy" };

  const first = await installClientReferences({ clientComponents, registry });
  first.close();

  const second = await installClientReferences({ clientComponents, registry });
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

  const install = await installClientReferences({
    clientComponents: { [file]: "Copy" },
    registry,
  });
  try {
    const namespace = (await import(
      /* @vite-ignore */ pathToFileURL(file).href
    )) as Record<string, unknown>;

    expect(namespace.SIZE).toBe(3);
  } finally {
    install.close();
  }
});

test("a boundary module's non-component export is passed through unproxied", async () => {
  const file = boundary(
    `export default function Copy() { return null; }\nexport const SIZE = 3;\nexport function helper() { return "h"; }\n`,
  );

  const install = await installClientReferences({
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
    install.close();
  }
});

test("closing an installation, and refusing a build, both leave the factory slot as they found it", async () => {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const FACTORY = Symbol.for("@pagedeck/core client reference factory");
  expect(FACTORY in slots).toBe(false);

  const clean = boundary(`export default function Copy() { return null; }\n`);
  const install = await installClientReferences({
    clientComponents: { [clean]: "Copy" },
    registry,
  });
  expect(slots[FACTORY]).toBeTypeOf("function");
  install.close();
  expect(FACTORY in slots).toBe(false);

  const cached = boundary(`export default function Copy() { return null; }\n`);
  await import(/* @vite-ignore */ pathToFileURL(cached).href);
  await expect(
    installClientReferences({
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

async function refusalOf(input: Parameters<typeof installClientReferences>[0]) {
  return installClientReferences(input).then(
    (install) => {
      install.close();
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

  const install = await installClientReferences({
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
    install.close();
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

  const install = await installClientReferences({
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
    install.close();
  }
});

test("a boundary module's relative export * is read through, and its names proxied", async () => {
  const dir = directory({
    "impl.js": `export function Panel() { return "panel"; }\nexport const LIMIT = 4;\nexport default function Hidden() { return null; }\n`,
    "Barrel.js": `"use client";\nexport * from "./impl.js";\n`,
  });
  const file = join(dir, "Barrel.js");

  const install = await installClientReferences({
    clientComponents: { [file]: "Barrel" },
    registry: { Barrel: registry.Copy },
  });
  try {
    const namespace = await namespaceOf(file);
    expect(Object.keys(namespace).sort()).toEqual(["LIMIT", "Panel"]);
    expect(proxiedTarget(namespace.Panel)).toBeTypeOf("function");
    expect(namespace.LIMIT).toBe(4);
  } finally {
    install.close();
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
  await import(/* @vite-ignore */ pathToFileURL(a).href);

  const refusal = await refusalOf({
    clientComponents: { [a]: "A", [b]: "B" },
    registry: { A: registry.Copy, B: registry.Copy },
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  const message = (refusal as Error).message;
  const [config, imported] = message.split("\n\n") as [string, string];
  expect(config).toContain(`  "A" — "${a}"`);
  expect(config).not.toContain(`"${b}"`);
  expect(imported).toContain(`"${b}"`);
  expect(imported).toContain(`imported by "A"`);
  expect(imported).not.toContain("pagedeck.config.ts");
});

test("a boundary module that does not parse is refused, naming the module and the line", async () => {
  const dir = directory({
    "Broken.js": `"use client";\nexport default function Broken( {\n`,
  });
  const file = join(dir, "Broken.js");

  const refusal = await refusalOf({
    clientComponents: { [file]: "Broken" },
    registry: { Broken: registry.Copy },
  });

  expect(refusal).toBeInstanceOf(ConfigError);
  expect((refusal as Error).message).toMatch(
    new RegExp(`^Island loader: module "${file.replaceAll("/", "\\/")}" line \\d+: does not parse`),
  );
});
