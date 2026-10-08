import { ConfigError } from "@pagedeck/core/exit";
import {
  ROUTING_VERSION,
  unusableHeaderName,
  unusableHeaderValue,
  unwritableHeaderName,
} from "@pagedeck/core/routing";
import type { RoutingManifest, RoutingTree } from "@pagedeck/core/routing";

import type { ArtifactRole, EdgeArtifact, EdgeOutput } from "./artifact.js";
import type { Fault } from "./faults.js";
import { throwIfAny, treeOf } from "./faults.js";
import { compiledTree } from "./normalize.js";
import type { CompiledTree } from "./normalize.js";

export interface EdgeAdapter<A extends EdgeArtifact = EdgeArtifact> {
  /** Quoted in every refusal, as `Edge target "<name>"`, and carried in `EdgeOutput.target`. */
  readonly name: string;
  /** Throws one `ConfigError` naming every fault the document holds for this host. */
  compile(routing: RoutingManifest): EdgeOutput<A>;
}

export interface AdapterDefinition<A extends EdgeArtifact = EdgeArtifact> {
  name: string;
  /** Byte ceiling per role; a role with no limit here is not measured. */
  limits: Readonly<Partial<Record<ArtifactRole, number>>>;
  /** Pushes each fault rather than throwing it, so one run reports every fault (rule 5). */
  compileTree(tree: CompiledTree, faults: Fault[]): readonly A[];
  /** Names an oversized artifact; `<tree>'s "<path>"` when absent. */
  describe?(artifact: A): string;
  /** The fix an `unsupported` fault names, where this adapter knows a better one. */
  unsupportedFix?: string;
}

function checkVersion(name: string, version: number): void {
  if (version === ROUTING_VERSION) return;
  const read = String(ROUTING_VERSION);
  const reader = `edge adapter "${name}"`;
  throw new ConfigError(
    version > ROUTING_VERSION
      ? `Routing manifest: version ${String(version)} is newer than ${reader} reads (${read}) — upgrade the @pagedeck/adapter-* package you compile with, or build with the @pagedeck/core that wrote it`
      : `Routing manifest: version ${String(version)} is older than ${reader} reads (${read}) — upgrade the @pagedeck/core that wrote it, or downgrade the @pagedeck/adapter-* package you compile with`,
  );
}

// Every adapter, before its own grammar: a compiler is handed a document, not necessarily one
// `planRouting` wrote (#671).
function checkHeaders(tree: RoutingTree, faults: Fault[]): void {
  for (const rule of tree.headers) {
    for (const field of rule.set) {
      const name = JSON.stringify(field.name);
      const under = `under prefix "${rule.prefix}"`;
      const nameReason = unusableHeaderName(field.name);
      if (nameReason !== undefined) {
        faults.push({
          kind: "header-name",
          line: `${treeOf(tree.domain)}'s header name ${name} ${under} — ${nameReason}`,
        });
      }
      const lineReason =
        nameReason === undefined ? unwritableHeaderName(field.name) : undefined;
      if (lineReason !== undefined) {
        faults.push({
          kind: "unwritable-header-name",
          line: `${treeOf(tree.domain)}'s header name ${name} ${under} — ${lineReason}`,
        });
      }
      const valueReason = unusableHeaderValue(field.value);
      if (valueReason !== undefined) {
        faults.push({
          kind: "header-value",
          line: `${treeOf(tree.domain)}'s header ${name} ${under} — ${valueReason}`,
        });
      }
    }
  }
}

function describePath(artifact: EdgeArtifact): string {
  return `${treeOf(artifact.domain)}'s "${artifact.path}"`;
}

export function defineAdapter<A extends EdgeArtifact>(
  definition: AdapterDefinition<A>,
): EdgeAdapter<A> {
  const { name, limits } = definition;
  const describe = definition.describe ?? describePath;
  return {
    name,
    compile(manifest) {
      checkVersion(name, manifest.version);

      const faults: Fault[] = [];
      for (const tree of manifest.trees) checkHeaders(tree, faults);
      // Folded once here, so no two adapters can derive different normalizing rules.
      const artifacts = manifest.trees.flatMap((tree) =>
        definition.compileTree(
          compiledTree(tree, manifest.site.trailingSlash),
          faults,
        ),
      );

      // Measured over the real text, never estimated: a second model of the emitter can disagree.
      for (const artifact of artifacts) {
        const limit = limits[artifact.role];
        if (limit === undefined) continue;
        const bytes = Buffer.byteLength(artifact.contents, "utf8");
        if (bytes <= limit) continue;
        faults.push({
          kind: "oversize",
          line: `${describe(artifact)} — ${String(bytes)} bytes, limit ${String(limit)}`,
        });
      }
      throwIfAny(name, faults, definition.unsupportedFix);

      return { target: name, artifacts };
    },
  };
}
