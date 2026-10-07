import { ConfigError } from "./exit.js";

export type Directive = "use client" | "use server";

export interface ModuleGraph {
  entries: readonly string[];
  imports: ReadonlyMap<string, readonly string[]>;
  directives: ReadonlyMap<string, Directive>;
}

export interface ClientBoundary {
  module: string;
  closure: readonly string[];
  reachedBy: readonly string[];
}

export interface BoundarySet {
  boundaries: readonly ClientBoundary[];
  clientModules: readonly string[];
}

function reachableFrom(
  from: string,
  imports: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>([from]);
  const pending = [from];
  while (pending.length > 0) {
    const module = pending.pop();
    if (module === undefined) break;
    for (const imported of [...(imports.get(module) ?? [])].sort()) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      pending.push(imported);
    }
  }
  return seen;
}

function chainsFromEntries(graph: ModuleGraph): Map<string, string> {
  const via = new Map<string, string>();
  const queue: string[] = [];
  for (const entry of [...graph.entries].sort()) {
    if (via.has(entry)) continue;
    via.set(entry, entry);
    queue.push(entry);
  }
  for (let at = 0; at < queue.length; at += 1) {
    const module = queue[at];
    if (module === undefined) continue;
    for (const imported of [...(graph.imports.get(module) ?? [])].sort()) {
      if (via.has(imported)) continue;
      via.set(imported, module);
      queue.push(imported);
    }
  }
  return via;
}

function chainTo(module: string, via: ReadonlyMap<string, string>): string[] {
  const chain = [module];
  let at = module;
  for (;;) {
    const importer = via.get(at);
    if (importer === undefined || importer === at) break;
    chain.unshift(importer);
    at = importer;
  }
  return chain;
}

function declaring(
  graph: ModuleGraph,
  directive: Directive,
  reached: ReadonlyMap<string, string>,
): string[] {
  return [...graph.directives]
    .filter(
      ([module, declared]) => declared === directive && reached.has(module),
    )
    .map(([module]) => module)
    .sort();
}

const SUBJECT = "Island boundaries: ";

const SERVER_FIX =
  '"use server" declares a server function, and the framework has no runtime request handler to run one (non-goal §3), so drop the import or move the work into the build';

function serverDirectiveReport(
  reachable: readonly { module: string; chain: readonly string[] }[],
): string {
  const count = reachable.length;
  const headline =
    count === 1
      ? '1 module carrying "use server" is reached by a rendered entry'
      : `${String(count)} modules carrying "use server" are reached by rendered entries`;
  const detail = reachable
    .map(({ module, chain }) => `  "${module}" — ${chain.join(" → ")}`)
    .join("\n");
  return `${SUBJECT}${headline} — ${SERVER_FIX}:\n${detail}`;
}

export function resolveBoundaries(graph: ModuleGraph): BoundarySet {
  const via = chainsFromEntries(graph);

  const reachableServer = declaring(graph, "use server", via).map((module) => ({
    module,
    chain: chainTo(module, via),
  }));
  if (reachableServer.length > 0) {
    throw new ConfigError(serverDirectiveReport(reachableServer));
  }

  const entryReach = [...new Set([...graph.entries].sort())].map((entry) => ({
    entry,
    reaches: reachableFrom(entry, graph.imports),
  }));

  const boundaries = declaring(graph, "use client", via).map((module) => ({
    module,
    closure: [...reachableFrom(module, graph.imports)].sort(),
    reachedBy: entryReach
      .filter(({ reaches }) => reaches.has(module))
      .map(({ entry }) => entry),
  }));

  const clientModules = new Set<string>();
  for (const boundary of boundaries) {
    for (const module of boundary.closure) clientModules.add(module);
  }
  return { boundaries, clientModules: [...clientModules].sort() };
}
