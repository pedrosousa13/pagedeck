import { ConfigError } from "@pagedeck/core/exit";
import {
  ROUTING_VERSION,
  unusableHeaderName,
  unusableHeaderValue,
  unwritableHeaderName,
} from "@pagedeck/core/routing";
import type { AdapterSite } from "@pagedeck/core";
import type {
  RoutingManifest,
  RoutingTree,
  UpstreamRoute,
} from "@pagedeck/core/routing";

import type { ArtifactRole, EdgeArtifact, EdgeOutput } from "./artifact.js";
import type { Fault } from "./faults.js";
import { throwIfAny, treeOf } from "./faults.js";
import { compiledTree } from "./normalize.js";
import type { CompiledTree } from "./normalize.js";

export interface EdgeAdapter<A extends EdgeArtifact = EdgeArtifact> {
  /** Quoted in every refusal, as `Edge target "<name>"`, and carried in `EdgeOutput.target`. */
  readonly name: string;
  /**
   * Throws one `ConfigError` naming every fault the document holds for this host. `pagedeck
   * build` passes `site`.
   */
  compile(routing: RoutingManifest, site?: AdapterSite): EdgeOutput<A>;
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
  /** Absent, `defineAdapter` refuses every tree that declares an upstream prefix. */
  upstreams?: UpstreamPolicy;
  /**
   * Pushes the faults no one tree holds, such as an adapter option naming a prefix no tree
   * declares, or a host file beside the config that disagrees with the document.
   */
  checkManifest?(manifest: RoutingManifest, faults: Fault[], site?: AdapterSite): void;
}

/**
 * How an adapter that routes upstreams reaches the app: through the deployed
 * origin each upstream's `url` names, or with no `url`, where the host runs the
 * app itself, or either, where the adapter decides per prefix. Under `refused`,
 * `fix` is what a refused `url` names, where this adapter knows a better one;
 * under `optional`, it is what the adapter's own `upstream-url-missing` faults name.
 */
export type UpstreamPolicy =
  | { url: "required" }
  | { url: "refused"; fix?: string }
  | { url: "optional"; fix: string };

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

function upstreamsLine(
  domain: string | undefined,
  upstreams: readonly UpstreamRoute[],
): string {
  return `${treeOf(domain)}'s ${
    upstreams.length === 1 ? "prefix" : "prefixes"
  } ${upstreams.map(({ prefix }) => JSON.stringify(prefix)).join(", ")} (build.routing.upstreams)`;
}

// Refused, not dropped: a host that serves the prefix as files answers the app's requests with
// the site's 404.
function refuseUpstreams(
  tree: RoutingTree,
  policy: UpstreamPolicy | undefined,
  faults: Fault[],
): void {
  const upstreams = tree.upstreams ?? [];
  if (upstreams.length === 0) return;
  if (policy === undefined) {
    faults.push({ kind: "upstream", line: upstreamsLine(tree.domain, upstreams) });
    return;
  }
  if (policy.url === "optional") return;
  const required = policy.url === "required";
  const wrong = upstreams.filter(({ url }) => (url === undefined) === required);
  if (wrong.length === 0) return;
  faults.push({
    kind: required ? "upstream-url-missing" : "upstream-url-refused",
    line: upstreamsLine(tree.domain, wrong),
  });
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
    compile(manifest, site) {
      checkVersion(name, manifest.version);

      const faults: Fault[] = [];
      for (const tree of manifest.trees) {
        checkHeaders(tree, faults);
        refuseUpstreams(tree, definition.upstreams, faults);
      }
      definition.checkManifest?.(manifest, faults, site);
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
      const policy = definition.upstreams;
      throwIfAny(name, faults, {
        unsupported: definition.unsupportedFix,
        upstreamUrlMissing: policy?.url === "optional" ? policy.fix : undefined,
        upstreamUrlRefused: policy?.url === "refused" ? policy.fix : undefined,
      });

      return { target: name, artifacts };
    },
  };
}
