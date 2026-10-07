import { ConfigError } from "@pagedeck/core/exit";
import {
  ROUTING_VERSION,
  unusableHeaderName,
  unusableHeaderValue,
} from "@pagedeck/core/routing";
import type { RoutingManifest, RoutingTree } from "@pagedeck/core/routing";

import type { ArtifactRole, EdgeArtifact, EdgeOutput } from "./artifact.js";
import {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
  compileCloudFront,
} from "./cloudfront.js";
import type { Fault } from "./faults.js";
import { throwIfAny, treeOf } from "./faults.js";
import {
  CLOUDFLARE_WORKER_LIMIT,
  compileWorker,
} from "./cloudflare-worker.js";
import { compileNetlify } from "./netlify.js";
import { compileNginx } from "./nginx.js";
import { compiledTree } from "./normalize.js";
import type { CompiledTree } from "./normalize.js";
import { EDGE_TARGETS } from "./target.js";
import type { EdgeTarget } from "./target.js";

export { EDGE_TARGETS } from "./target.js";
export type { EdgeTarget } from "./target.js";
export type {
  ArtifactRole,
  EdgeArtifact,
  EdgeOutput,
  EventSlot,
  FunctionRuntime,
} from "./artifact.js";
export {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
} from "./cloudfront.js";
export {
  CLOUDFLARE_WORKER_LIMIT,
  WORKER_ORIGIN_BINDING,
} from "./cloudflare-worker.js";

export interface EdgeOptions {
  /** `string`, not `EdgeTarget`: the caller is a CLI flag or a config field. */
  target: string;
  /** Byte ceiling per role; defaults to CloudFront's function limit and KeyValueStore quota, and the Workers script limit. */
  limits?: Partial<Record<ArtifactRole, number>>;
}

// Per tree, and `faults` is threaded rather than thrown so one run reports every fault (rule 5).
type Compiler = (
  tree: CompiledTree,
  limit: number | undefined,
  faults: Fault[],
) => readonly EdgeArtifact[];

const COMPILERS: Readonly<Record<EdgeTarget, Compiler>> = {
  "cloudfront-function": compileCloudFront,
  netlify: compileNetlify,
  nginx: compileNginx,
  "cloudflare-worker": compileWorker,
};

function isTarget(target: string): target is EdgeTarget {
  return (EDGE_TARGETS as readonly string[]).includes(target);
}

function checkVersion(version: number): void {
  if (version === ROUTING_VERSION) return;
  const read = String(ROUTING_VERSION);
  throw new ConfigError(
    version > ROUTING_VERSION
      ? `Routing manifest: version ${String(version)} is newer than this compiler reads (${read}) — upgrade @pagedeck/edge, or build with the @pagedeck/core that wrote it`
      : `Routing manifest: version ${String(version)} is older than this compiler reads (${read}) — upgrade the @pagedeck/core that wrote it, or downgrade @pagedeck/edge`,
  );
}

// Every target, before its own grammar: a compiler is handed a document, not necessarily one
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

function describe(artifact: EdgeArtifact): string {
  const tree = treeOf(artifact.domain);
  return artifact.slot === undefined
    ? `${tree}'s "${artifact.path}"`
    : `${tree}'s ${artifact.slot} function`;
}

export function compileRouting(
  manifest: RoutingManifest,
  options: EdgeOptions,
): EdgeOutput {
  const { target } = options;
  if (!isTarget(target)) {
    throw new ConfigError(
      `Edge target "${target}" is not supported — use one of: ${EDGE_TARGETS.join(", ")}`,
    );
  }
  checkVersion(manifest.version);

  const limits = {
    function: CLOUDFRONT_FUNCTION_LIMIT,
    dataset: CLOUDFRONT_KVS_LIMIT,
    "edge-module": CLOUDFLARE_WORKER_LIMIT,
    ...options.limits,
  };
  const compile = COMPILERS[target];
  const faults: Fault[] = [];
  for (const tree of manifest.trees) checkHeaders(tree, faults);
  // Folded once here, so no two targets can derive different normalizing rules.
  const artifacts = manifest.trees.flatMap((tree) =>
    compile(
      compiledTree(tree, manifest.site.trailingSlash),
      limits.function,
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
  throwIfAny(target, faults);

  return { target, artifacts };
}
