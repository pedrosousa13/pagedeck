import { DEPLOY_DIRECTORY, DEPLOY_MANIFEST_PATH } from "@pagedeck/core/routing";
import type { RoutingTree } from "@pagedeck/core/routing";

import { refuseOffsite, treeOf } from "@pagedeck/edge";
import type { CompiledTree, EdgeArtifact, Fault } from "@pagedeck/edge";

import {
  cloudflarePagesPattern,
  unexpressibleInCloudflarePagesPattern,
} from "./encode.js";

// https://developers.cloudflare.com/pages/configuration/redirects/#per-file : 2,000 static and
// 100 dynamic (a splat or a placeholder), 2,100 combined. Every row this adapter writes is a
// concrete address — `RoutingTree.redirects` holds no pattern to begin with, and `check` below
// refuses an authored one that holds "*" or ":" before it ever reaches a row — except
// its own fixed `/.pagedeck/*` denial, one row that never nears the smaller cap on its own. So
// the only limit a real site can ever reach is the static one, counted over every row including
// that one.
const STATIC_REDIRECT_LIMIT = 2000;
const REDIRECT_LINE_LIMIT = 1000;
// https://developers.cloudflare.com/pages/configuration/headers/#attach-a-header
const HEADER_RULE_LIMIT = 100;
const HEADER_LINE_LIMIT = 2000;

/**
 * Written at the tree's root when the tree declares no 404 page, so the reserved-key proxy below
 * always has a real file to render instead of the key's own bytes. Core writes a page at this
 * same path when the tree does declare one (docs/reference/routing.md, "The 404 page"); this
 * fallback carries no site content, so a reserved key resolves to a bare host 404 either way.
 */
const FALLBACK_NOT_FOUND = "/404.html";
const FALLBACK_BODY =
  '<!doctype html>\n<meta charset="utf-8">\n<title>Not Found</title>\n<p>Not Found</p>\n';

function check(
  tree: RoutingTree,
  what: string,
  value: string,
  faults: Fault[],
): void {
  const why = unexpressibleInCloudflarePagesPattern(value);
  if (why !== undefined) {
    faults.push({
      kind: "unexpressible",
      line: `${treeOf(tree.domain)}'s ${what} — ${why}`,
    });
  }
}

function lineLimit(
  tree: RoutingTree,
  what: string,
  line: string,
  limit: number,
  faults: Fault[],
): void {
  if (line.length <= limit) return;
  faults.push({
    kind: "oversize",
    line: `${treeOf(tree.domain)}'s ${what} — ${String(line.length)} characters, limit ${String(limit)}`,
  });
}

interface Row {
  source: string;
  destination: string;
  code: number;
}

function redirectsFile(
  tree: CompiledTree,
  faults: Fault[],
): string {
  if (tree.notFound !== undefined) check(tree, "404 page", tree.notFound, faults);
  // Reserved deploy keys: Cloudflare Pages cannot rewrite with a status other than 200
  // (https://developers.cloudflare.com/pages/configuration/redirects/#advanced-redirects), so a
  // key is proxied (200, in place) to the tree's 404 page — redirects always run ahead of a real
  // file here (redirects.md, "Per line": "Redirects are always followed, regardless of whether or
  // not an asset matches the incoming request"), so the key's own bytes never serve. With no 404
  // page the target is this adapter's own fallback above, so the key still resolves to a bare 404
  // rather than Cloudflare's single-page-application fallback for a missing top-level 404.html
  // (https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering).
  const target = tree.notFound ?? FALLBACK_NOT_FOUND;
  const rows: Row[] = [
    { source: DEPLOY_MANIFEST_PATH, destination: target, code: 200 },
    { source: DEPLOY_DIRECTORY, destination: target, code: 200 },
    { source: `${DEPLOY_DIRECTORY}/*`, destination: target, code: 200 },
  ];

  for (const rule of tree.redirects) {
    if (!rule.normalizing) {
      const offsite = refuseOffsite(tree.domain, rule, faults);
      if (!offsite.from) check(tree, `redirect from "${rule.from}"`, rule.from, faults);
      if (!offsite.to) check(tree, `redirect target on "${rule.from}"`, rule.to, faults);
    }
    rows.push({ source: rule.from, destination: rule.to, code: rule.status });
  }

  const lines = rows.map(
    (row) => `${row.source} ${row.destination} ${String(row.code)}`,
  );
  for (const [index, line] of lines.entries()) {
    const row = rows[index];
    if (row === undefined) continue;
    lineLimit(tree, `redirect from "${row.source}"`, line, REDIRECT_LINE_LIMIT, faults);
  }

  if (rows.length > STATIC_REDIRECT_LIMIT) {
    faults.push({
      kind: "oversize",
      line: `${treeOf(tree.domain)}'s _redirects — ${String(rows.length)} redirects, limit ${String(STATIC_REDIRECT_LIMIT)}`,
    });
  }

  return `${lines.join("\n")}\n`;
}

// Cloudflare applies every header rule whose pattern matches, joining a repeated name with a
// comma (headers.md, "Attach a header"), unlike the routing document's one-rule-wins model. So a
// longer (more specific) rule detaches (`! Name`) every header a shorter enclosing rule sets that
// it does not itself set (headers.md, "Detach a header"). That section's own example writes the
// broad rule (`/*`) before the narrow one that detaches it (`/*.jpg`), so this writes the shortest
// prefix first and the longest (most specific) last, the opposite of `tree.headers`' longest-first
// order, which assumes a first-match host.
function headersFile(tree: CompiledTree, faults: Fault[]): string | undefined {
  if (tree.headers.length > HEADER_RULE_LIMIT) {
    faults.push({
      kind: "oversize",
      line: `${treeOf(tree.domain)}'s _headers — ${String(tree.headers.length)} header rules, limit ${String(HEADER_RULE_LIMIT)}`,
    });
  }

  const ordered = [...tree.headers].sort((a, b) => a.prefix.length - b.prefix.length);

  const blocks = ordered.map((rule, index) => {
    check(tree, `header prefix "${rule.prefix}"`, rule.prefix, faults);
    const ownNames = new Set(rule.set.map((field) => field.name.toLowerCase()));
    const detach: string[] = [];
    const detached = new Set<string>();
    for (let earlier = 0; earlier < index; earlier++) {
      const enclosing = ordered[earlier];
      if (enclosing === undefined || !rule.prefix.startsWith(enclosing.prefix)) {
        continue;
      }
      for (const field of enclosing.set) {
        const lower = field.name.toLowerCase();
        if (ownNames.has(lower)) {
          faults.push({
            kind: "unexpressible",
            line: `${treeOf(tree.domain)}'s header ${JSON.stringify(field.name)} under prefix "${rule.prefix}" — also set under the enclosing prefix "${enclosing.prefix}", and Cloudflare Pages joins a header set twice with a comma rather than letting a nested rule replace it`,
          });
        } else if (!detached.has(lower)) {
          detached.add(lower);
          detach.push(`  ! ${field.name}`);
        }
      }
    }
    const lines = [
      `${cloudflarePagesPattern(rule.prefix)}*`,
      ...detach,
      ...rule.set.map((field) => `  ${field.name}: ${field.value}`),
    ];
    for (const line of lines) {
      lineLimit(tree, `header line under prefix "${rule.prefix}"`, line, HEADER_LINE_LIMIT, faults);
    }
    return lines.join("\n");
  });

  return blocks.length === 0 ? undefined : `${blocks.join("\n\n")}\n`;
}

export function compileCloudflarePages(
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

  // Once per compile, whichever tree hits it first: the policy is the whole site's, not one
  // tree's own (https://developers.cloudflare.com/pages/configuration/serving-pages/#route-matching).
  if (
    tree.trailingSlash === "never" &&
    !faults.some((fault) => fault.kind === "trailing-slash")
  ) {
    faults.push({
      kind: "trailing-slash",
      line: `${treeOf(tree.domain)} — site.trailingSlash is "never", and Cloudflare Pages redirects a directory's index.html to its slashed address on its own`,
    });
  }

  artifacts.push({
    ...domain,
    role: "tree-file",
    path: "/_redirects",
    contents: redirectsFile(tree, faults),
  });

  if (tree.notFound === undefined) {
    artifacts.push({
      ...domain,
      role: "tree-file",
      path: FALLBACK_NOT_FOUND,
      contents: FALLBACK_BODY,
    });
  }

  const headers = headersFile(tree, faults);
  if (headers !== undefined) {
    artifacts.push({ ...domain, role: "tree-file", path: "/_headers", contents: headers });
  }

  return artifacts;
}
