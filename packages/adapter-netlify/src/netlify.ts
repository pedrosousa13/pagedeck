import { DEPLOY_DIRECTORY, DEPLOY_MANIFEST_PATH } from "@pagedeck/core/routing";
import type { RoutingTree } from "@pagedeck/core/routing";

import { treeOf, UNSERVED_KEY } from "@pagedeck/edge";
import type { CompiledTree, EdgeArtifact, Fault } from "@pagedeck/edge";

import {
  netlifyHeaderValue,
  netlifyPattern,
  unexpressibleInNetlifyPattern,
} from "./encode.js";

const CATCH_ALL = "/*";

function check(
  tree: RoutingTree,
  what: string,
  value: string,
  faults: Fault[],
): void {
  const why = unexpressibleInNetlifyPattern(value);
  if (why !== undefined) {
    faults.push({
      kind: "unexpressible",
      line: `${treeOf(tree.domain)}'s ${what} — ${why}`,
    });
  }
}

export function compileNetlify(
  tree: CompiledTree,
  faults: Fault[],
): readonly EdgeArtifact[] {
  const artifacts: EdgeArtifact[] = [];
  const domain = tree.domain === undefined ? {} : { domain: tree.domain };

  // Refused, not dropped: compiling the rest would ship the primary with no word that the split
  // is gone.
  if (tree.experiments !== undefined) {
    const pages = tree.experiments.map((split) => `"${split.path}"`).join(", ");
    faults.push({
      kind: "unsupported",
      line: `${treeOf(tree.domain)}'s ${
        tree.experiments.length === 1 ? "experiment" : "experiments"
      } on ${pages} (build.routing.experiments)`,
    });
  }

  // The reserved keys first and forced (#556): this format takes the first match, and an
  // unforced row loses to a file the origin holds.
  const denied = netlifyPattern(tree.notFound ?? UNSERVED_KEY);
  const rows = [
    DEPLOY_MANIFEST_PATH,
    DEPLOY_DIRECTORY,
    `${DEPLOY_DIRECTORY}/*`,
  ].map((pattern) => `${pattern} ${denied} 404!`);
  for (const rule of tree.redirects) {
    if (!rule.normalizing) {
      check(tree, `redirect from "${rule.from}"`, rule.from, faults);
      check(tree, `redirect target on "${rule.from}"`, rule.to, faults);
    }
    // Forced on derived rows only: the origin's document at the other spelling is what the row
    // must beat. An authored `from` is never a page of this build.
    const forced = rule.normalizing ? "!" : "";
    rows.push(
      `${netlifyPattern(rule.from)} ${netlifyPattern(rule.to)} ${String(rule.status)}${forced}`,
    );
  }
  if (tree.notFound !== undefined) {
    // Last, and a 404: this row serves the document with that status.
    check(tree, "404 page", tree.notFound, faults);
    rows.push(`${CATCH_ALL} ${netlifyPattern(tree.notFound)} 404`);
  }
  artifacts.push({
    ...domain,
    role: "tree-file",
    path: "/_redirects",
    contents: `${rows.join("\n")}\n`,
  });

  const blocks = tree.headers.map((rule) => {
    check(tree, `header prefix "${rule.prefix}"`, rule.prefix, faults);
    // `<prefix>*`: a bare pattern is an exact path.
    const lines = rule.set.map(
      (field) => `  ${field.name}: ${netlifyHeaderValue(field.value)}`,
    );
    return [`${netlifyPattern(rule.prefix)}*`, ...lines].join("\n");
  });
  if (blocks.length > 0) {
    artifacts.push({
      ...domain,
      role: "tree-file",
      path: "/_headers",
      contents: `${blocks.join("\n\n")}\n`,
    });
  }

  return artifacts;
}
