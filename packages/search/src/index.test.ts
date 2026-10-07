import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import * as search from "./index.js";
import { defineSearch, QUERY_CAP } from "./index.js";

const SRC = import.meta.dirname;

// `import type` is skipped (`verbatimModuleSyntax` erases it); dynamic imports are edges.
function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g,
  )) {
    if (match[1] === undefined && match[2] !== undefined) found.push(match[2]);
  }
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

function graph(entry: string): Map<string, string[]> {
  const reached = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (reached.has(file)) continue;
    const specifiers = imports(file);
    reached.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      // Source carries `.js` specifiers; both `.ts` and `.tsx` are tried, and an unresolvable edge
      // throws rather than being skipped.
      const base = resolve(dirname(file), specifier).replace(/\.js$/, "");
      const source = [`${base}.ts`, `${base}.tsx`].find((candidate) =>
        existsSync(candidate),
      );
      if (source === undefined) {
        throw new Error(
          `${file} imports "${specifier}", and neither ${base}.ts nor ${base}.tsx is there for this walk to follow`,
        );
      }
      pending.push(source);
    }
  }
  return reached;
}

function faults(reached: Map<string, string[]>): string[] {
  const found: string[] = [];
  for (const [file, specifiers] of reached) {
    for (const specifier of specifiers) {
      const reaches =
        specifier === "react" ||
        specifier.startsWith("react/") ||
        specifier.startsWith("react-dom") ||
        specifier.endsWith("/query.js") ||
        specifier.endsWith("/island.js");
      if (reaches) {
        found.push(
          `  ${file.slice(SRC.length + 1)} imports "${specifier}", which pagedeck build would then load`,
        );
      }
    }
  }
  return found;
}

test("search exposes the adapter a site declares and the cap a site is held to, and nothing else", () => {
  expect(typeof defineSearch).toBe("function");
  // Sorted: Node and Vitest's transform list a namespace's exports in different orders.
  expect([...Object.keys(search)].sort()).toEqual(["QUERY_CAP", "defineSearch"]);
  expect(QUERY_CAP).toBeGreaterThan(0);
});

test("the browser half is reached through its own entries, never the index", async () => {
  expect(search).not.toHaveProperty("createSearchClient");
  expect(search).not.toHaveProperty("SearchIsland");

  const query = await import("@pagedeck/search/query");
  expect(typeof query.createSearchClient).toBe("function");
  const island = await import("@pagedeck/search/island");
  expect(typeof island.default).toBe("function");
});

test("nothing the index imports reaches React or the query runtime", () => {
  const reached = graph(join(SRC, "index.ts"));
  // A floor: an empty graph would pass every assertion below.
  expect(reached.size).toBeGreaterThan(2);

  expect(faults(reached).join("\n")).toBe("");
});

test("the same walk finds React where React is", () => {
  const reached = graph(join(SRC, "island.test.tsx"));
  expect([...reached.keys()]).toContain(join(SRC, "island.tsx"));
  expect(faults(reached).length).toBeGreaterThan(0);
});
