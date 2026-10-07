import { runBundle } from "./bundler.js";
import {
  UNRESOLVED_FIX,
  inProductionEnv,
  resolveModuleIds,
} from "./client-build.js";
import { recordIslandBoundaries } from "./directive-scan.js";
import type {
  ResourceImporter,
  UnparsedModule,
} from "./directive-scan.js";
import { UNPARSABLE_REFUSAL } from "./directive-source.js";
import { resolveBoundaries } from "./directives.js";
import type { ModuleGraph } from "./directives.js";
import { serveGeneratedEntries } from "./entry-modules.js";
import type { ModuleMap } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { ModuleFacts } from "@pagedeck/islands";

export interface IslandFactsInput {
  root: string;
  origin: string;
  modules: ModuleMap;
}

export interface IslandFacts {
  facts: Readonly<Record<string, ModuleFacts>>;
  clientComponents: Readonly<Record<string, string>>;
  warnings: readonly string[];
}

const ENTRY_ID = "\0fw:island-facts";

const RESOLVE_ID = "\0fw:component-modules";

export interface ResolvedModules {
  ids: Readonly<Record<string, string>>;
  unresolved: readonly string[];
}

/** The scan's resolution alone, with no graph, as the scan's `ssr.noExternal` reads it. */
export async function resolveComponentModules(
  specifiers: readonly string[],
  input: { root: string; origin: string },
): Promise<ResolvedModules> {
  const resolver = resolveModuleIds(specifiers, input.origin);
  await inProductionEnv(async () =>
    runBundle({
      config: {
        configFile: false,
        envDir: false,
        logLevel: "warn",
        mode: "production",
        root: input.root,
        ssr: { noExternal: true },
        build: {
          ssr: true,
          write: false,
          rolldownOptions: { input: { components: RESOLVE_ID } },
        },
      },
      plugins: [
        serveGeneratedEntries(new Map([[RESOLVE_ID, "export {};\n"]]), input.origin),
        resolver.plugin,
      ],
    }),
  );
  return resolver.taken();
}

export async function scanIslandFacts(
  input: IslandFactsInput,
): Promise<IslandFacts> {
  const names = Object.keys(input.modules).sort();
  if (names.length === 0) {
    return { facts: {}, clientComponents: {}, warnings: [] };
  }

  const specifiers = [
    ...new Set(names.map((name) => input.modules[name] as string)),
  ].sort();

  const resolver = resolveModuleIds(specifiers, input.origin);
  let graph: ModuleGraph | undefined;
  const scan = recordIslandBoundaries((recorded) => {
    graph = recorded;
  });

  const entry = specifiers
    .map((specifier) => `import ${JSON.stringify(specifier)};\n`)
    .join("");

  let failure: unknown;
  let hookFault: unknown;
  try {
    await inProductionEnv(async () =>
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
          // Explicit: the dev transform writes absolute paths into module text.
          oxc: { jsx: { runtime: "automatic", development: false } },
          root: input.root,
          build: {
            // SSR, where `ssr.noExternal` makes a `"use client"` module inside
            // a package visible.
            ssr: true,
            write: false,
            rolldownOptions: { input: { islands: ENTRY_ID } },
          },
        },
        plugins: [
          scan.plugin,
          serveGeneratedEntries(new Map([[ENTRY_ID, entry]]), input.origin),
          resolver.plugin,
        ],
      }),
    );
  } catch (error) {
    failure = error;
  }

  const { ids, unresolved } = resolver.taken();
  const { unparsed, resourceImporters } = scan.taken();
  // First: a hook that faulted leaves the graph incomplete, so the reports
  // below would mislead.
  if (hookFault !== undefined) throw hookFault;
  if (unresolved.length > 0) {
    throw new ConfigError(unresolvedReport(input, unresolved));
  }
  // Before `failure`: the same fault, said in the site's terms and by class
  // (rule 7, #83).
  if (unparsed.length > 0) throw new ConfigError(unparsedReport(unparsed));
  if (failure !== undefined) throw failure;

  if (graph === undefined) {
    throw new Error(
      `Island scan: the module graph was built but never came back, so no component can be told static from interactive — this is a framework fault, not a site one; report it against @pagedeck/core`,
    );
  }

  // Here, not in `buildEnd`: it throws a `ConfigError`, and a hook must not
  // throw.
  const boundaries = resolveBoundaries(graph);

  const boundaryModules = new Set(
    boundaries.boundaries.map((boundary) => boundary.module),
  );

  const clientModules = new Set(boundaries.clientModules);
  const placers = resourceImporters.filter(({ id }) => clientModules.has(id));
  const warnings =
    placers.length === 0 ? [] : [resourcePlacerWarning(placers)];
  const facts: Record<string, ModuleFacts> = {};
  const namesByModule = new Map<string, string[]>();
  for (const name of names) {
    const id = ids[input.modules[name] as string];
    const useClient = id !== undefined && boundaryModules.has(id);
    facts[name] = { useClient };
    if (useClient) {
      const registered = namesByModule.get(id as string);
      if (registered === undefined) namesByModule.set(id as string, [name]);
      else registered.push(name);
    }
  }

  const shared = [...namesByModule]
    .filter(([, registered]) => registered.length > 1)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  if (shared.length > 0) throw new ConfigError(sharedModuleReport(shared));

  const clientComponents: Record<string, string> = {};
  for (const [id, registered] of namesByModule) {
    clientComponents[id] = registered[0] as string;
  }
  return { facts, clientComponents, warnings };
}

function resourcePlacerWarning(placers: readonly ResourceImporter[]): string {
  const lines = placers
    .map(({ id, names }) => `  "${id}" — ${names.join(", ")}`)
    .join("\n");
  const subject =
    placers.length === 1
      ? '1 module in a "use client" closure imports'
      : `${String(placers.length)} modules in a "use client" closure import`;
  return `Island scan: ${subject} preinit or preinitModule from react-dom — a preinit call places a stylesheet past the <head> tiers the build owns, which the build refuses when the rendered HTML shows it; this is a warning and not a refusal because a call made from an effect leaves nothing in the HTML to see, and an import reached through a re-export or an alias leaves nothing here to see either:\n${lines}`;
}

function sharedModuleReport(
  shared: readonly (readonly [string, readonly string[]])[],
): string {
  const lines = shared.map(
    ([id, names]) =>
      `  "${id}" — ${names.map((name) => `"${name}"`).join(", ")}`,
  );
  return `Island scan: ${String(shared.length)} ${
    shared.length === 1
      ? 'module carrying "use client" is registered under more than one component name, so a rendered instance of it cannot be told which name it is'
      : 'modules carrying "use client" are registered under more than one component name, so a rendered instance of one cannot be told which name it is'
  } — register it under one name, or give each name a module of its own:\n${lines.join("\n")}`;
}

function unparsedReport(unparsed: readonly UnparsedModule[]): string {
  const lines = unparsed.map(({ id, error }) => {
    const cause = error.cause;
    const parsed = cause instanceof Error ? cause.message : error.message;
    const frame = parsed
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  "${id}" —\n${frame}`;
  });
  const subject =
    unparsed.length === 1 ? "component module" : "component modules";
  const scope = unparsed.length === 1 ? "" : " in each";
  return `Island scan: ${String(unparsed.length)} ${subject} ${UNPARSABLE_REFUSAL}${scope}:\n${lines.join("\n")}`;
}

function unresolvedReport(
  input: IslandFactsInput,
  unresolved: readonly string[],
): string {
  const missing = new Set(unresolved);
  const lines = Object.keys(input.modules)
    .sort()
    .filter((name) => missing.has(input.modules[name] as string))
    .map(
      (name) =>
        `  "${name}" — "${input.modules[name] as string}", resolved against "${input.origin}"`,
    );
  return `Island scan: ${String(lines.length)} ${
    lines.length === 1
      ? "component module did not resolve, so its directive could not be read"
      : "component modules did not resolve, so their directives could not be read"
  } — ${UNRESOLVED_FIX}:\n${lines.join("\n")}`;
}
