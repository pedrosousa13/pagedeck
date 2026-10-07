import { statSync } from "node:fs";
import { registerHooks } from "node:module";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RELOAD_QUERY } from "./config.js";

export interface SiteModules {
  /** Every site file resolved since the install, stamped as it was then. */
  files(): ReadonlyMap<string, string>;
  /** Each file, and every site file importing one, loads afresh on its next import. */
  changed(files: readonly string[]): void;
  /** `"use client"` modules, known once the config has loaded. */
  leaveClientModules(paths: ReadonlySet<string>): void;
  close(): void;
}

/**
 * `"use client"` modules keep their plain URL, the one the island loader stands
 * in for (#703).
 */
export function trackSiteModules(root: string): SiteModules {
  let clientModules: ReadonlySet<string> = new Set();
  const files = new Map<string, string>();
  const importers = new Map<string, Set<string>>();
  const epochs = new Map<string, number>();
  let generation = 0;

  const sitePath = (url: string): string | undefined => {
    if (!url.startsWith("file:")) return undefined;
    const path = fileURLToPath(url);
    const inside = relative(root, path);
    if (inside === "" || inside.startsWith("..")) return undefined;
    if (inside.split(sep).includes("node_modules")) return undefined;
    return clientModules.has(path) ? undefined : path;
  };

  const hooks = registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const resolved = nextResolve(specifier, context);
      if (new URL(resolved.url).search !== "") return resolved;
      const path = sitePath(resolved.url);
      if (path === undefined) return resolved;
      if (!files.has(path)) files.set(path, stamp(path));
      const parent =
        context.parentURL === undefined
          ? undefined
          : sitePath(context.parentURL);
      if (parent !== undefined) {
        const above = importers.get(path) ?? new Set<string>();
        above.add(parent);
        importers.set(path, above);
      }
      const epoch = epochs.get(path);
      if (epoch === undefined) return resolved;
      const url = new URL(resolved.url);
      url.searchParams.set(RELOAD_QUERY, String(epoch));
      return { ...resolved, url: url.href };
    },
  });

  return {
    files: () => files,
    changed: (changed) => {
      generation += 1;
      const pending = [...changed];
      const dirty = new Set<string>();
      for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
        if (dirty.has(path)) continue;
        dirty.add(path);
        epochs.set(path, generation);
        pending.push(...(importers.get(path) ?? []));
      }
    },
    leaveClientModules: (paths) => {
      clientModules = paths;
      for (const path of paths) files.delete(path);
    },
    close: () => {
      hooks.deregister();
    },
  };
}

export function stamp(file: string): string {
  try {
    const stats = statSync(file);
    return `${String(stats.mtimeMs)} ${String(stats.size)}`;
  } catch {
    return "—";
  }
}
