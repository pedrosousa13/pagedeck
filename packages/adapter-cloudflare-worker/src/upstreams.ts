import type { RoutingManifest } from "@pagedeck/core/routing";

import { treeOf } from "@pagedeck/edge";
import type { CompiledTree, Fault } from "@pagedeck/edge";

/** The service binding each upstream prefix reaches its app through, keyed by prefix. */
export type ServiceBindings = Readonly<Record<string, { binding: string }>>;

export type WorkerRoute =
  | { prefix: string; binding: string }
  | { prefix: string; url: string };

// https://developers.cloudflare.com/workers/wrangler/configuration/ : a binding "must be a valid
// JavaScript variable name". An IdentifierName; a reserved word is not refused.
const VARIABLE_NAME = /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u;

const OPTION = "cloudflareWorker({ upstreams })";

export const NO_URL_FIX = `name a service binding for each in ${OPTION}, such as { "/api/": { binding: "APP" } }, or set url on each to the https origin the deployed app answers at`;

const STRAY = {
  subject: {
    one: `prefix in ${OPTION} is one no tree sends to an app`,
    many: `prefixes in ${OPTION} are ones no tree sends to an app`,
  },
  fix: "correct each to a prefix in build.routing.upstreams, or remove it from the option",
};

const UNNAMEABLE = {
  subject: {
    one: `binding in ${OPTION} is not a valid JavaScript variable name`,
    many: `bindings in ${OPTION} are not valid JavaScript variable names`,
  },
  fix: 'rename each, in the option and in the Worker\'s wrangler configuration, to a name such as "APP" that starts with a letter, $ or _ and holds only letters, digits, $ and _',
};

// Either wins only by a precedence rule, which ADR-0001 keeps out of routing.
const BOTH = {
  subject: {
    one: "prefix names both a url and a service binding",
    many: "prefixes name both a url and a service binding",
  },
  fix: `remove url from each in build.routing.upstreams, or remove it from ${OPTION}`,
};

export function checkBindings(
  bindings: ServiceBindings,
  manifest: RoutingManifest,
  faults: Fault[],
): void {
  const declared = [
    ...new Set(
      manifest.trees.flatMap((tree) =>
        (tree.upstreams ?? []).map(({ prefix }) => prefix),
      ),
    ),
  ];
  const listed =
    declared.length === 0
      ? "build.routing.upstreams declares no prefix"
      : `build.routing.upstreams declares ${declared.map((prefix) => JSON.stringify(prefix)).join(", ")}`;
  for (const [prefix, { binding }] of Object.entries(bindings)) {
    if (!declared.includes(prefix)) {
      faults.push({ kind: "adapter", ...STRAY, line: `${JSON.stringify(prefix)} — ${listed}` });
    }
    if (!VARIABLE_NAME.test(binding)) {
      faults.push({
        kind: "adapter",
        ...UNNAMEABLE,
        line: `${JSON.stringify(binding)} for ${JSON.stringify(prefix)}`,
      });
    }
  }
}

export function routesOf(
  tree: CompiledTree,
  bindings: ServiceBindings,
  faults: Fault[],
): readonly WorkerRoute[] {
  const routes: WorkerRoute[] = [];
  const unreached: string[] = [];
  for (const { prefix, url } of tree.upstreams ?? []) {
    const binding = Object.hasOwn(bindings, prefix)
      ? bindings[prefix]?.binding
      : undefined;
    if (binding !== undefined && url !== undefined) {
      faults.push({
        kind: "adapter",
        ...BOTH,
        line: `${treeOf(tree.domain)}'s prefix ${JSON.stringify(prefix)} — url ${JSON.stringify(url)}, binding ${JSON.stringify(binding)}`,
      });
    } else if (binding !== undefined) {
      routes.push({ prefix, binding });
    } else if (url !== undefined) {
      routes.push({ prefix, url });
    } else {
      unreached.push(prefix);
    }
  }
  if (unreached.length > 0) {
    faults.push({
      kind: "upstream-url-missing",
      line: `${treeOf(tree.domain)}'s ${
        unreached.length === 1 ? "prefix" : "prefixes"
      } ${unreached.map((prefix) => JSON.stringify(prefix)).join(", ")} (build.routing.upstreams)`,
    });
  }
  return routes;
}
