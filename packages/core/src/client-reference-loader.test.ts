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
