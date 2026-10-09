import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin, PluginOption } from "vite";
import { runBundle } from "./bundler.js";
import { ISLANDS_STARTUP, runtimeImports } from "./entries.js";
import type { EntryPlan } from "./entries.js";
import { entryInputs, serveEntryModules } from "./entry-modules.js";
import { ConfigError } from "./exit.js";
import type { EmittedFile, FileKind, ManifestChunk } from "./manifest.js";
import { compileIslands } from "./react-compiler.js";
import { redactTarget } from "./snapshot.js";
import { CORE_GROUP, MID_GROUP, codeSplitting } from "./tiers.js";
import type { ModuleIds, TierPlan } from "./tiers.js";

export interface ClientBuildInput {
  root: string;
  origin: string;
  plan: EntryPlan;
  tiers: TierPlan;
  globalCss?: readonly string[];
  plugins?: readonly PluginOption[];
  split?: readonly ManifestChunk[];
}

export interface ClientBuild {
  files: readonly EmittedFile[];
  entryScripts: ReadonlyMap<string, string>;
  entryStyles: ReadonlyMap<string, readonly string[]>;
  globalStyles: readonly string[];
  modules: ReadonlyMap<string, readonly string[]>;
  imports: ReadonlyMap<string, readonly string[]>;
  ids: ModuleIds;
  warnings: readonly string[];
}

export const ASSET_DIR = "assets";

// Left to default splitting, they change chunks when a page's island set does,
// and a page an incremental build reuses names a chunk that is gone (#694).
const REACT_RUNTIMES = ["react/jsx-runtime", "react/compiler-runtime"] as const;

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patterned(fileName: string, name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  return new RegExp(
    `^${literal(ASSET_DIR)}/${literal(stem)}-[A-Za-z0-9_-]+${literal(ext)}$`,
  ).test(fileName);
}

export function contentNaming(): {
  assetFileNames: (asset: { names: readonly string[] }) => string;
  hashed: (
    emitted:
      | { type: "chunk"; fileName: string; preliminaryFileName: string }
      | { type: "asset"; fileName: string; names: readonly string[] },
  ) => boolean;
} {
  const named = new Set<string>();
  const keyOf = (names: readonly string[]): string | undefined =>
    names.length === 0 ? undefined : JSON.stringify(names);
  return {
    assetFileNames(asset) {
      const key = keyOf(asset.names);
      if (key !== undefined) named.add(key);
      return `${ASSET_DIR}/[name]-[hash][extname]`;
    },
    hashed(emitted) {
      if (emitted.type === "chunk") return emitted.preliminaryFileName !== emitted.fileName;
      const key = keyOf(emitted.names);
      return (
        key !== undefined &&
        named.has(key) &&
        emitted.names.some((name) => patterned(emitted.fileName, name))
      );
    },
  };
}

export function chunkPath(fileName: string): string {
  return `/${fileName}`;
}

export interface ClientChunkFacts {
  fileName: string;
  name: string;
  isEntry: boolean;
  imports: readonly string[];
  modules: readonly string[];
}

export interface ModuleIdResolver {
  plugin: Plugin;
  taken(): { ids: ModuleIds; unresolved: readonly string[] };
}

export const UNRESOLVED_FIX =
  "install the package, or fix the component's path or specifier in build.components";
const ENTRY_FIX =
  "check that none of the site's build.vite.plugins emits, renames or drops a chunk under a generated entry's name";
const CAPTURE_FIX =
  "check the module map spells the tier's specifiers the way the pages import them";
const DUPLICATE_FIX = {
  one: "report it upstream with the id below, and build on another Vite release to ship meanwhile, since the site's own configuration cannot cause this and cannot fix it",
  many: "report them upstream with the ids below, and build on another Vite release to ship meanwhile, since the site's own configuration cannot cause this and cannot fix it",
} as const;
const COPY_FIX = {
  one: "install one copy of the package, by deduplicating the lockfile or hoisting it into the site's own dependencies",
  many: "install one copy of each package, by deduplicating the lockfile or hoisting them into the site's own dependencies",
} as const;
const CLOSED_FIX =
  "build the whole graph in one invocation, and externalize nothing";

function packagePath(id: string): string | undefined {
  const at = id.lastIndexOf("/node_modules/");
  if (at === -1) return undefined;
  return id.slice(at + "/node_modules/".length);
}

function packageVersion(id: string): string | undefined {
  const boundary = id.lastIndexOf("/node_modules/");
  if (boundary === -1) return undefined;
  const floor = id.slice(0, boundary + "/node_modules".length);
  let dir = id.slice(0, id.lastIndexOf("/"));
  while (dir.length > floor.length) {
    const version = declaredVersion(`${dir}/package.json`);
    if (version !== undefined) return version;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return undefined;
}

function sameVersion(ids: ReadonlySet<string>): Map<string, string[]> {
  const byVersion = new Map<string, string[]>();
  for (const id of ids) {
    const version = packageVersion(id);
    if (version === undefined) continue;
    const group = byVersion.get(version);
    if (group === undefined) byVersion.set(version, [id]);
    else group.push(id);
  }
  for (const [version, group] of byVersion) {
    if (group.length < 2) byVersion.delete(version);
  }
  return byVersion;
}

function declaredVersion(path: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

export function resolveModuleIds(
  specifiers: readonly string[],
  origin: string,
): ModuleIdResolver {
  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  return {
    plugin: {
      name: "pagedeck:resolve-module-ids",

      async buildStart() {
        resolved.clear();
        unresolved.length = 0;
        for (const specifier of specifiers) {
          const answer = await this.resolve(specifier, origin).catch(
            () => null,
          );
          if (answer === null || answer === undefined) {
            unresolved.push(specifier);
          } else {
            resolved.set(specifier, answer.id);
          }
        }
      },
    },
    taken: () => ({
      ids: Object.fromEntries(resolved),
      unresolved: [...unresolved],
    }),
  };
}

// Below the tiers, so a tier captures what it captured when the split was
// recorded.
const SPLIT_PRIORITY = 10;

export const STARTUP_GROUP = "fw-startup";

// Above core, which would otherwise take both as dependencies of its own modules,
// and a page with no `load` island imports them at startup without core.
const STARTUP_PRIORITY = 40;

// Vite's own id for the helper it wraps each dynamic `import()` in.
const PRELOAD_HELPER = "\0vite/preload-helper.js";

function midChunk(name: string): boolean {
  return name === MID_GROUP || name.startsWith(`${MID_GROUP}~`);
}

// A path relative to the site, so a manifest pins the same split on another
// machine.
function recordedId(root: string, id: string): string {
  if (!isAbsolute(id)) return id;
  const path = relative(root, id).split(sep).join("/");
  return path.startsWith("../") ? path : `./${path}`;
}

function bundlerId(root: string, recorded: string): string {
  return recorded.startsWith("./") || recorded.startsWith("../")
    ? resolve(root, recorded)
    : recorded;
}

function withoutQuery(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

export function checkClientGraph(input: {
  plan: EntryPlan;
  tiers: TierPlan;
  chunks: readonly ClientChunkFacts[];
  captured: ReadonlySet<string>;
}): void {
  const counts = new Map<string, number>();
  for (const chunk of input.chunks) {
    if (!chunk.isEntry) continue;
    counts.set(chunk.name, (counts.get(chunk.name) ?? 0) + 1);
  }

  const entryFaults: string[] = [];
  const pagesOfName = new Map<string, string[]>();
  for (const entry of input.plan.entries) {
    const page = `${entry.locale} ${entry.path}`;
    const seen = pagesOfName.get(entry.name);
    if (seen === undefined) pagesOfName.set(entry.name, [page]);
    else seen.push(page);
  }
  for (const [name, pages] of pagesOfName) {
    const count = counts.get(name) ?? 0;
    if (count === 1) continue;
    entryFaults.push(
      `  "${name}" — ${String(count)} entry chunks came back under that name, for ${pages.join(", ")}`,
    );
  }

  const holders = new Map<string, string[]>();
  for (const chunk of input.chunks) {
    for (const id of chunk.modules) {
      const seen = holders.get(id);
      if (seen === undefined) holders.set(id, [chunk.fileName]);
      else seen.push(chunk.fileName);
    }
  }
  const duplicateFaults = [...holders]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, files]) => `  "${id}" — in ${files.join(", ")}`);

  const copies = new Map<string, Set<string>>();
  for (const id of holders.keys()) {
    const key = packagePath(id);
    if (key === undefined) continue;
    const seen = copies.get(key);
    if (seen === undefined) copies.set(key, new Set([id]));
    else seen.add(id);
  }
  const copyFaults = [...copies]
    .filter(([, ids]) => ids.size > 1)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([key, ids]) =>
      [...sameVersion(ids)]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(
          ([version, group]) =>
            `  "${key}" version ${version} — at ${group.sort().join(", ")}`,
        ),
    );

  const emitted = new Set(input.chunks.map((chunk) => chunk.fileName));
  const openFaults = [
    ...new Set(
      input.chunks.flatMap((chunk) =>
        chunk.imports
          .filter((specifier) => !emitted.has(specifier))
          .map(
            (specifier) =>
              `  "${redactTarget(specifier)}" — imported by ${chunk.fileName}`,
          ),
      ),
    ),
  ].sort();

  const captureFaults = input.tiers.groups
    .filter((group) => !input.captured.has(group.name))
    .map(
      (group) =>
        `  "${group.name}" — no module in the emitted graph matched it`,
    );

  const sections: string[] = [];
  if (entryFaults.length > 0) {
    sections.push(
      paragraph(
        entryFaults.length,
        entryFaults.length === 1
          ? "page entry did not come back as exactly one chunk"
          : "page entries did not come back as exactly one chunk",
        ENTRY_FIX,
        entryFaults,
      ),
    );
  }
  if (captureFaults.length > 0) {
    sections.push(
      paragraph(
        captureFaults.length,
        captureFaults.length === 1
          ? "chunk tier captured no module"
          : "chunk tiers captured no module",
        CAPTURE_FIX,
        captureFaults,
      ),
    );
  }
  if (duplicateFaults.length > 0) {
    sections.push(
      paragraph(
        duplicateFaults.length,
        duplicateFaults.length === 1
          ? "module came back in more than one chunk, so islands sharing it would get an instance each"
          : "modules came back in more than one chunk, so islands sharing them would get an instance each",
        duplicateFaults.length === 1 ? DUPLICATE_FIX.one : DUPLICATE_FIX.many,
        duplicateFaults,
      ),
    );
  }
  if (copyFaults.length > 0) {
    sections.push(
      paragraph(
        copyFaults.length,
        copyFaults.length === 1
          ? "module came back from more than one copy of its package at one version, so islands sharing it would get an instance each"
          : "modules came back from more than one copy of their package at one version, so islands sharing them would get an instance each",
        copyFaults.length === 1 ? COPY_FIX.one : COPY_FIX.many,
        copyFaults,
      ),
    );
  }
  if (openFaults.length > 0) {
    sections.push(
      paragraph(
        openFaults.length,
        openFaults.length === 1
          ? "chunk import does not name a chunk this build emitted, so a module outside the graph would be loaded on its own and the singleton guarantee would stop at this invocation"
          : "chunk imports do not name a chunk this build emitted, so a module outside the graph would be loaded on its own and the singleton guarantee would stop at this invocation",
        CLOSED_FIX,
        openFaults,
      ),
    );
  }
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));
}

export async function buildClient(
  input: ClientBuildInput,
): Promise<ClientBuild> {
  if (input.plan.entries.length === 0) {
    return {
      files: [],
      entryScripts: new Map(),
      entryStyles: new Map(),
      globalStyles: [],
      modules: new Map(),
      imports: new Map(),
      ids: {},
      warnings: [],
    };
  }

  const grouped = new Set(input.tiers.groups.flatMap((group) => group.modules));
  const resolver = resolveModuleIds(
    [
      ...new Set([
        ...grouped,
        ...REACT_RUNTIMES,
        ISLANDS_STARTUP,
        ...input.plan.entries.flatMap((entry) => [
          ...runtimeImports(entry),
          ...entry.components.map((component) => component.module),
        ]),
      ]),
    ],
    input.origin,
  );

  // A thunk: each group reads the record on its first `test`, after
  // `buildStart` has resolved it.
  const splitting = codeSplitting(input.tiers, () => resolver.taken().ids);
  const captured = new Set<string>();
  const globalCss = new Set(input.globalCss ?? []);
  let runtimes: Set<string> | undefined;
  const reactRuntime = (id: string): boolean => {
    runtimes ??= new Set(
      REACT_RUNTIMES.flatMap((specifier) => {
        const resolved = resolver.taken().ids[specifier];
        return resolved === undefined ? [] : [resolved];
      }),
    );
    return runtimes.has(id);
  };
  for (const group of splitting.groups) {
    const test = group.test;
    // A global stylesheet and React's runtimes go to core by rule, not to save
    // bytes: a stylesheet in its importer's tier is lost to the other pages.
    const core = group.name === CORE_GROUP;
    group.test = (id: string) => {
      const plain = withoutQuery(id);
      const hit = test(id) || (core && (globalCss.has(plain) || reactRuntime(plain)));
      if (hit) captured.add(group.name);
      return hit;
    };
  }

  // Left to Rolldown, a module that lost an importer moves, renaming the
  // chunks of pages an incremental build reuses (#720).
  for (const chunk of input.split ?? []) {
    const held = new Set(chunk.modules.map((id) => bundlerId(input.root, id)));
    splitting.groups.push({
      name: chunk.name,
      priority: SPLIT_PRIORITY,
      minSize: 0,
      minShareCount: 1,
      test: (id: string) => held.has(withoutQuery(id)),
    });
  }

  splitting.groups.push({
    name: STARTUP_GROUP,
    priority: STARTUP_PRIORITY,
    minSize: 0,
    minShareCount: 1,
    test: (id: string) => {
      const plain = withoutQuery(id);
      return (
        plain === PRELOAD_HELPER ||
        plain === resolver.taken().ids[ISLANDS_STARTUP]
      );
    },
  });

  const compiler = compileIslands();
  const naming = contentNaming();

  let hookFault: unknown;
  const result = await inProductionEnv(async () =>
    runBundle({
      onFault: (fault) => {
        hookFault ??= fault.error;
      },
      config: {
        configFile: false,
        envDir: false,
        logLevel: "warn",
        mode: "production",
        define: { "process.env.NODE_ENV": '"production"' },
        oxc: { jsx: { runtime: "automatic", development: false } },
        root: input.root,
        build: {
          write: false,
          assetsDir: ASSET_DIR,
          rolldownOptions: {
            // The whole map, always: a partial graph would duplicate the shared
            // store against the core chunk (spec §11, #64).
            input: entryInputs(input.plan),
            output: {
              entryFileNames: `${ASSET_DIR}/[name]-[hash].js`,
              chunkFileNames: `${ASSET_DIR}/[name]-[hash].js`,
              assetFileNames: naming.assetFileNames,
              codeSplitting: splitting,
            },
          },
        },
      },
      plugins: [
        compiler.plugin,
        serveEntryModules(input.plan, input.origin, input.globalCss),
        resolver.plugin,
      ],
      // Site plugins go last on purpose: ahead of these they could claim the
      // virtual entries. `enforce: "pre"` still runs first.
      sitePlugins: input.plugins,
    })
      // A failure over a component specifier is the site's wiring and is
      // rewrapped (#235); anything else is rethrown as it arrived.
      .catch((failure: unknown): never => {
        // A hook fault first, or the rewrap would reclassify it.
        if (hookFault !== undefined) throw hookFault;
        const wrapped = refuseUnresolvedComponents(
          failure,
          input.plan,
          resolver.taken().unresolved,
          input.origin,
        );
        throw wrapped ?? failure;
      }),
  );

  const { ids, unresolved } = resolver.taken();
  // Before the graph check: an unresolved group captures nothing, so every
  // later fault would mislead.
  const unresolvedGroups = unresolved.filter((specifier) =>
    grouped.has(specifier),
  );
  if (unresolvedGroups.length > 0) {
    throw new ConfigError(unresolvedReport(unresolvedGroups, input.origin));
  }

  const files: EmittedFile[] = [];
  const modules = new Map<string, readonly string[]>();
  const imports = new Map<string, readonly string[]>();
  const entryScripts = new Map<string, string>();
  const chunks: ClientChunkFacts[] = [];
  const cssOfChunk = new Map<string, readonly string[]>();

  const outputs = Array.isArray(result) ? result : [result];
  for (const one of outputs) {
    if (!("output" in one)) continue;
    for (const emitted of one.output) {
      const path = chunkPath(emitted.fileName);
      if (emitted.type === "chunk") {
        const held = Object.keys(emitted.modules);
        const splitByRolldown =
          !emitted.isEntry &&
          !emitted.isDynamicEntry &&
          emitted.name !== CORE_GROUP &&
          emitted.name !== STARTUP_GROUP &&
          !midChunk(emitted.name);
        files.push({
          path,
          kind: "js",
          name: emitted.name,
          ...(naming.hashed(emitted) ? { hashed: true as const } : {}),
          ...(splitByRolldown
            ? {
                chunk: {
                  name: emitted.name,
                  modules: [
                    ...new Set(held.map((id) => recordedId(input.root, withoutQuery(id)))),
                  ].sort(),
                },
              }
            : {}),
          contents: emitted.code,
        });
        modules.set(path, held);
        chunks.push({
          fileName: emitted.fileName,
          name: emitted.name,
          isEntry: emitted.isEntry,
          imports: [...emitted.imports, ...emitted.dynamicImports],
          modules: held,
        });
        imports.set(path, emitted.imports.map(chunkPath));
        cssOfChunk.set(emitted.fileName, [
          ...(emitted.viteMetadata?.importedCss ?? []),
        ]);
        if (emitted.isEntry) entryScripts.set(emitted.name, path);
      } else {
        files.push({
          path,
          kind: assetKind(emitted.fileName),
          ...(naming.hashed(emitted) ? { hashed: true as const } : {}),
          contents: emitted.source,
        });
      }
    }
  }

  checkClientGraph({
    plan: input.plan,
    tiers: input.tiers,
    chunks,
    captured,
  });

  return {
    files,
    entryScripts,
    entryStyles: planEntryStyles(chunks, cssOfChunk),
    globalStyles: planGlobalStyles(globalCss.size > 0, chunks, cssOfChunk),
    modules,
    imports,
    ids,
    warnings: compiler.taken(),
  };
}

function planGlobalStyles(
  declared: boolean,
  chunks: readonly ClientChunkFacts[],
  cssOfChunk: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (!declared) return [];
  return chunks
    .filter((chunk) => chunk.name === CORE_GROUP)
    .flatMap((chunk) => cssOfChunk.get(chunk.fileName) ?? [])
    .map((css) => chunkPath(css))
    .sort();
}

function styleRank(chunkName: string): number {
  if (chunkName === CORE_GROUP) return 0;
  if (midChunk(chunkName)) return 1;
  return 2;
}

function planEntryStyles(
  chunks: readonly ClientChunkFacts[],
  cssOfChunk: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly string[]> {
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const styles = new Map<string, readonly string[]>();
  for (const entry of chunks) {
    if (!entry.isEntry) continue;
    const walked = new Set<string>([entry.fileName]);
    const queue = [entry.fileName];
    const reached = new Map<string, number>();
    for (let at = 0; at < queue.length; at += 1) {
      const chunk = byFileName.get(queue[at] as string);
      if (chunk === undefined) continue;
      for (const css of cssOfChunk.get(chunk.fileName) ?? []) {
        const rank = styleRank(chunk.name);
        const seen = reached.get(css);
        if (seen === undefined || rank < seen) reached.set(css, rank);
      }
      for (const next of chunk.imports) {
        if (walked.has(next)) continue;
        walked.add(next);
        queue.push(next);
      }
    }
    if (reached.size === 0) continue;
    styles.set(
      entry.name,
      [...reached]
        .sort(([aCss, aRank], [bCss, bRank]) =>
          aRank === bRank ? (aCss < bCss ? -1 : 1) : aRank - bRank,
        )
        .map(([css]) => chunkPath(css)),
    );
  }
  return styles;
}

/**
 * Vite reads `process.env.NODE_ENV` for `isProduction` and has no config field
 * for it (Vite 8.2.2), so the build sets it and restores it after.
 */
export async function inProductionEnv<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

export function assetKind(fileName: string): FileKind {
  return fileName.endsWith(".css") ? "css" : "asset";
}

function paragraph(
  count: number,
  subject: string,
  fix: string,
  lines: readonly string[],
): string {
  return `Client build: ${String(count)} ${subject} — ${fix}:\n${lines.join("\n")}`;
}

function refuseUnresolvedComponents(
  failure: unknown,
  plan: EntryPlan,
  unresolved: readonly string[],
  origin: string,
): ConfigError | undefined {
  const missing = new Set(unresolved);
  const faults = plan.entries.flatMap((entry) =>
    entry.components
      .filter((component) => missing.has(component.module))
      .map(
        (component) =>
          `  "${component.name}" — "${component.module}" — imported by the entry for ${entry.locale} ${entry.path}`,
      ),
  );
  if (faults.length === 0) return undefined;
  return new ConfigError(componentUnresolvedReport(faults, origin), {
    cause: failure,
  });
}

function componentUnresolvedReport(
  faults: readonly string[],
  origin: string,
): string {
  return paragraph(
    faults.length,
    faults.length === 1
      ? "component specifier did not resolve"
      : "component specifiers did not resolve",
    UNRESOLVED_FIX,
    faults.map((fault) => `${fault}, resolved against "${origin}"`),
  );
}

function unresolvedReport(
  unresolved: readonly string[],
  origin: string,
): string {
  return paragraph(
    unresolved.length,
    unresolved.length === 1
      ? "grouped specifier did not resolve"
      : "grouped specifiers did not resolve",
    UNRESOLVED_FIX,
    unresolved.map(
      (specifier) => `  "${specifier}" — resolved against "${origin}"`,
    ),
  );
}
