// Read off the module graph, not `dist`: Rolldown keeps a directive only in an
// entry chunk whose entry module carries it.
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";
import { catalog } from "./catalog.js";
import { components } from "./index.js";
import { recordIslandBoundaries } from "@pagedeck/core/directive-scan";
import { resolveBoundaries } from "@pagedeck/core";
import { resolveHydrationMode } from "@pagedeck/islands";
import type { BoundarySet, ModuleGraph } from "@pagedeck/core";
import type { Catalog } from "./catalog.js";

const ISLANDS: readonly string[] = [
  "consent_banner",
  "landing_page",
  "pricing_page",
];

const FORCED: readonly string[] = [];

const resolve = createRequire(import.meta.url).resolve;

const MODULE_ID = new Map(
  Object.entries(catalog).map(([name, entry]) => [name, resolve(entry.module)]),
);

function componentOf(id: string): string | undefined {
  const path = id.split("?")[0] ?? id;
  for (const [name, module] of MODULE_ID) if (module === path) return name;
  return undefined;
}

const PAGE = { locale: "en", path: "/home" } as const;

let boundaries: BoundarySet | undefined;

beforeAll(async () => {
  // Resolved outside the plugin: it can throw, and a `ConfigError` thrown from a
  // build hook does not survive (#94).
  let recorded: ModuleGraph | undefined;
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      ssr: true,
      // `write: false`, so two runs of this file never race over one `outDir`.
      write: false,
      minify: false,
      rollupOptions: { input: [...MODULE_ID.values()] },
    },
    plugins: [
      recordIslandBoundaries((found) => {
        recorded = found;
      }).plugin,
    ],
  });
  if (recorded !== undefined) boundaries = resolveBoundaries(recorded);
}, 120_000);

afterAll(() => {
  boundaries = undefined;
});

test("the scan found the catalog's boundaries", () => {
  if (boundaries === undefined) throw new Error("the scan reported nothing");
  expect(boundaries.boundaries.length).toBeGreaterThan(0);
  const found = boundaries.boundaries
    .map((boundary) => componentOf(boundary.module))
    .filter((name) => name !== undefined)
    .sort();
  expect(found).toEqual([...ISLANDS].sort());
});

test("the registry forces islandhood on exactly the reviewed components", () => {
  // Typed as `Catalog`: the literal's `satisfies` type has no `hydrate` property
  // on a row that omits it, so its absence could not be asked about.
  const rows: Catalog = catalog;
  const forced = Object.entries(rows)
    .filter(
      ([name, entry]) =>
        entry.hydrate !== undefined &&
        entry.hydrate !== "none" &&
        !ISLANDS.includes(name),
    )
    .map(([name]) => name)
    .sort();
  expect(forced).toEqual([...FORCED].sort());
});

test("every component classified static ships no JavaScript", () => {
  if (boundaries === undefined) throw new Error("the scan reported nothing");
  const shipped = new Set(boundaries.clientModules);
  const faults: string[] = [];
  for (const [name, module] of MODULE_ID) {
    const useClient = boundaries.boundaries.some(
      (boundary) => boundary.module === module,
    );
    const { mode } = resolveHydrationMode(components, name, PAGE, {
      useClient,
    });
    if (mode === "none" && shipped.has(module)) {
      faults.push(
        `  ${name} — classified "none", but a "use client" module imports it, so it is in the client payload`,
      );
    }
    if (mode !== "none" && !shipped.has(module)) {
      faults.push(
        `  ${name} — classified "${mode}", but nothing puts it in the client payload`,
      );
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});
