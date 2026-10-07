import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const PACKAGES = join(import.meta.dirname, "..", "..");

const DOOR = join("core", "src", "bundler.ts");

const MINIMUM_MODULES = 100;

function sourceModules(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      found.push(path);
    }
  };
  for (const dir of readdirSync(PACKAGES).sort()) {
    const src = join(PACKAGES, dir, "src");
    if (!existsSync(src)) continue;
    walk(src);
  }
  return found;
}

function viteBindings(source: string): string[] {
  const bindings: string[] = [];
  // `[^}]*`, not `[\s\S]*?`: the lazy form swallowed the imports between two
  // `from "vite"` lines and read the wrong one.
  const named = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']vite["']/g;
  for (const match of source.matchAll(named)) {
    if (match[1] !== undefined) continue;
    for (const specifier of (match[2] ?? "").split(",")) {
      const name = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name !== undefined && name !== "") bindings.push(name);
    }
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*["']vite["']/.test(source)) {
    bindings.push("*");
  }
  return bindings;
}

test("build is imported from vite by one module in the workspace", () => {
  const modules = sourceModules();
  expect(modules.length).toBeGreaterThanOrEqual(MINIMUM_MODULES);

  const importers = modules
    .filter((path) => {
      const bindings = viteBindings(readFileSync(path, "utf8"));
      return bindings.includes("build") || bindings.includes("*");
    })
    .map((path) => relative(PACKAGES, path));

  expect(importers, importersReport(importers)).toEqual([DOOR]);
});

function importersReport(importers: readonly string[]): string {
  const others = importers.filter((path) => path !== DOOR);
  if (others.length === 0) {
    return `Bundler invocations: ${DOOR} does not import "build" from "vite" — it is the module that is supposed to, and the guard in it is what makes "never throw from a bundler hook" hold; restore the import, or move this rule to wherever build() went`;
  }
  const list = others.map((path) => path.split(sep).join("/")).join(", ");
  return `Bundler invocations: ${others.length} module${others.length === 1 ? "" : "s"} outside ${DOOR} import "build" from "vite" — call runBundle from @pagedeck/core's bundler.ts instead, which guards every hook on the plugins it is handed so a throw cannot be flattened into a plain Error (#225): ${list}`;
}
