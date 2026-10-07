import { readDirective, readResourceImports } from "./directive-source.js";
import type { Directive, ModuleGraph } from "./directives.js";
import type { Plugin } from "vite";

const SCRIPT = /\.[cm]?[jt]sx?$/;

export interface UnparsedModule {
  id: string;
  error: Error;
}

export interface ResourceImporter {
  id: string;
  names: readonly string[];
}

const RESOURCE_HINT = "preinit";

export interface IslandBoundaryScan {
  plugin: Plugin;
  taken(): {
    unparsed: readonly UnparsedModule[];
    resourceImporters: readonly ResourceImporter[];
  };
}

export function recordIslandBoundaries(
  onGraph: (graph: ModuleGraph) => void,
): IslandBoundaryScan {
  const entries = new Set<string>();
  const imports = new Map<string, readonly string[]>();
  const directives = new Map<string, Directive>();
  const unparsed = new Map<string, Error>();
  const resourceImports = new Map<string, readonly string[]>();

  const plugin: Plugin = {
    name: "pagedeck:record-island-boundaries",
    enforce: "pre",

    config() {
      return { ssr: { noExternal: true } };
    },

    transform(code, id) {
      const path = id.split("?")[0] ?? id;
      if (!SCRIPT.test(path)) return null;
      // Collected, never thrown: a hook must not throw, and one report names
      // every unparseable module (rule 5).
      try {
        const declared = readDirective(id, code);
        if (declared !== undefined) directives.set(id, declared);
        if (code.includes(RESOURCE_HINT)) {
          const names = readResourceImports(id, code);
          if (names.length > 0) resourceImports.set(path, names);
        }
      } catch (error) {
        unparsed.set(
          path,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return null;
    },

    moduleParsed(info) {
      if (info.isEntry) entries.add(info.id);
      imports.set(info.id, [
        ...info.importedIds,
        ...info.dynamicallyImportedIds,
      ]);
    },

    buildEnd(error) {
      if (error !== undefined) return;
      // Not resolved here: `resolveBoundaries` throws a `ConfigError`, and a
      // hook must not throw.
      const graph: ModuleGraph = {
        entries: [...entries],
        imports,
        directives,
      };
      onGraph(graph);
    },
  };

  return {
    plugin,
    taken: () => ({
      unparsed: [...unparsed]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([id, error]) => ({ id, error })),
      resourceImporters: [...resourceImports]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([id, names]) => ({ id, names })),
    }),
  };
}
