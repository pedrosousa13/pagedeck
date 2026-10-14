import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { missingUpstreamSourcesReport } from "./routing.js";
import type { UpstreamRule } from "./routing.js";

export interface UpstreamSource {
  entry: number;
  declared: string;
  path: string;
  directory: boolean;
}

export interface UpstreamSources {
  sources: readonly UpstreamSource[];
  /** The refusal of each declared `source` not on disk, if any. */
  missing: string | undefined;
}

const UPSTREAM_IMPORT_FIX =
  'import only the app\'s types, with "import type", or move the code both need out of the app\'s source';

export function upstreamSources(
  root: string,
  origin: string,
  upstreams: readonly UpstreamRule[],
): UpstreamSources {
  const sources: UpstreamSource[] = [];
  const missing: { entry: number; source: string; at: string }[] = [];
  upstreams.forEach((rule, entry) => {
    if (rule.source === undefined) return;
    const at = resolve(root, rule.source);
    try {
      const path = realpathSync(at);
      sources.push({
        entry,
        declared: rule.source,
        path,
        directory: statSync(path).isDirectory(),
      });
    } catch {
      missing.push({ entry, source: rule.source, at });
    }
  });
  return {
    sources,
    missing:
      missing.length === 0
        ? undefined
        : missingUpstreamSourcesReport(`Config "${origin}"`, missing),
  };
}

export function upstreamImportReport(
  where: string,
  lines: readonly string[],
): string {
  const subject =
    lines.length === 1
      ? "import from island code reaches the source of an upstream app, so the app's code would ship to the browser"
      : "imports from island code reach the source of an upstream app, so the app's code would ship to the browser";
  return `${where}: ${String(lines.length)} ${subject} — ${UPSTREAM_IMPORT_FIX}:\n${lines.join("\n")}`;
}

export function entryLabel(entry: { locale: string; path: string }): string {
  return `the entry for ${entry.locale} ${entry.path}`;
}

// A path relative to the site, so a manifest pins the same split on another
// machine.
export function recordedId(root: string, id: string): string {
  if (!isAbsolute(id)) return id;
  const path = relative(root, id).split(sep).join("/");
  return path.startsWith("../") ? path : `./${path}`;
}

export function withoutQuery(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

function realFile(id: string): string | undefined {
  const plain = withoutQuery(id);
  if (!isAbsolute(plain)) return undefined;
  try {
    return realpathSync(plain);
  } catch {
    return plain;
  }
}

/**
 * Client graph only: a server-rendered module may import the app. Pre-enforced,
 * or Vite's own resolver answers a relative import before this hook sees it.
 */
export function upstreamImportCheck(input: {
  root: string;
  origin: string;
  sources: () => readonly UpstreamSource[];
  entryName(id: string): string | undefined;
  reached(lines: readonly string[]): void;
}): Plugin {
  const { root, origin } = input;
  return {
    name: "pagedeck:upstream-sources",
    enforce: "pre",

    async resolveId(specifier, importer, options) {
      if (options.ssr === true) return null;
      const sources = input.sources();
      if (sources.length === 0) return null;
      const resolved = await this.resolve(specifier, importer, {
        ...options,
        skipSelf: true,
      });
      if (
        resolved === null ||
        (resolved.external ?? false) !== false ||
        importer === undefined ||
        importer === origin
      ) {
        return resolved;
      }
      const file = realFile(resolved.id);
      if (file === undefined) return resolved;
      const from =
        input.entryName(importer) ??
        `"${recordedId(root, withoutQuery(importer))}"`;
      const lines = sources
        .filter(
          (source) =>
            file === source.path ||
            (source.directory && file.startsWith(`${source.path}${sep}`)),
        )
        .map(
          (source) =>
            `  ${from} imports ${JSON.stringify(specifier)} — build.routing.upstreams[${String(source.entry)}] source ${JSON.stringify(source.declared)}`,
        );
      if (lines.length > 0) input.reached(lines);
      return resolved;
    },
  };
}
