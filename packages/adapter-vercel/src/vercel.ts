import { DEPLOY_DIRECTORY, DEPLOY_MANIFEST_PATH } from "@pagedeck/core/routing";
import type { HeaderField, RoutingTree } from "@pagedeck/core/routing";

import { refuseOffsite, treeOf } from "@pagedeck/edge";
import type { CompiledTree, EdgeArtifact, Fault } from "@pagedeck/edge";

import {
  unexpressibleInVercelDestination,
  unexpressibleInVercelPattern,
  vercelHeaderValue,
  vercelPattern,
} from "./encode.js";

// https://vercel.com/docs/routing/redirects/configuration-redirects#limits
const MAX_REDIRECTS = 2048;
const MAX_PATTERN_LENGTH = 4096;

const WELL_KNOWN = "/.well-known/";

function check(
  tree: RoutingTree,
  what: string,
  value: string,
  faults: Fault[],
): void {
  const why = unexpressibleInVercelPattern(value);
  if (why !== undefined) {
    faults.push({
      kind: "unexpressible",
      line: `${treeOf(tree.domain)}'s ${what} — ${why}`,
    });
  }
}

function checkLength(
  tree: RoutingTree,
  what: string,
  value: string,
  faults: Fault[],
): void {
  if (value.length <= MAX_PATTERN_LENGTH) return;
  faults.push({
    kind: "limit",
    line: `${treeOf(tree.domain)}'s ${what} — ${String(value.length)} characters, Vercel's documented limit for "source" and "destination" is ${String(MAX_PATTERN_LENGTH)} (https://vercel.com/docs/routing/redirects/configuration-redirects#limits)`,
  });
}

// Vercel applies every matching `headers` rule, so each excludes its nested siblings to keep one
// match per path; the excluded text sits in a regex group, so it is escaped (#37). A rule also
// applies to an external rewrite's response (https://vercel.com/docs/rewrites sets
// `CDN-Cache-Control` on one through `headers`), and the app sets its own, so each excludes the
// upstream prefixes under it, the unslashed path included.
function headerSource(prefix: string, exclusions: readonly string[]): string {
  const lookaheads = exclusions.map((pattern) => `(?!${pattern})`).join("");
  return `${prefix}:rest(${lookaheads}.*)`;
}

function headersFor(
  tree: RoutingTree,
  path: string,
): readonly HeaderField[] {
  const rule = tree.headers.find((candidate) => path.startsWith(candidate.prefix));
  return rule === undefined ? [] : rule.set;
}

function headerRecord(set: readonly HeaderField[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const field of set) record[field.name] = vercelHeaderValue(field.value);
  return record;
}

// `routes[].src` is PCRE (https://vercel.com/docs/project-configuration/vercel-json#routes),
// as is a path-to-regexp group in `headers[].source`, so a literal character with regex meaning
// is escaped.
function escapePcre(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface UpstreamRoute {
  src: string;
  dest: string;
}

interface ReservedRoute {
  src: string;
  status: 404;
  dest?: string;
  headers?: Record<string, string>;
}

export function compileVercel(
  tree: CompiledTree,
  faults: Fault[],
): readonly EdgeArtifact[] {
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

  // Every row `compiledTree` derives too, not only the authored ones: Vercel's own
  // `trailingSlash` setting exempts a path with a file extension
  // (https://vercel.com/docs/project-configuration/vercel-json#trailingslash), but an authored
  // redirect's own address is an author's path, not a claim that it is a file — "/sitemap-index.xml"
  // reads as one to that exemption and would never reach a rule that assumed the setting
  // canonicalized it first. Writing every row explicitly, the way `compiledTree` resolved it,
  // keeps that address independent of the setting's own heuristic.
  if (tree.redirects.length > MAX_REDIRECTS) {
    faults.push({
      kind: "limit",
      line: `${treeOf(tree.domain)} declares ${String(tree.redirects.length)} redirects, Vercel's documented limit is ${String(MAX_REDIRECTS)} (https://vercel.com/docs/routing/redirects/configuration-redirects#limits)`,
    });
  }
  const redirects = tree.redirects.map((rule) => {
    // The derived rows only reshape an authored address by a trailing slash: checking them
    // too would report the same bad character twice.
    if (!rule.normalizing) {
      const offsite = refuseOffsite(tree.domain, rule, faults);
      if (!offsite.from) check(tree, `redirect from "${rule.from}"`, rule.from, faults);
      if (!offsite.to) check(tree, `redirect target on "${rule.from}"`, rule.to, faults);
      checkLength(tree, `redirect from "${rule.from}"`, rule.from, faults);
      checkLength(tree, `redirect target on "${rule.from}"`, rule.to, faults);
    }
    return {
      source: vercelPattern(rule.from),
      destination: vercelPattern(rule.to),
      statusCode: rule.status,
    };
  });

  const upstreams = tree.upstreams ?? [];
  const siteHeaders = tree.headers.filter(
    (rule) => !upstreams.some(({ prefix }) => rule.prefix.startsWith(prefix)),
  );
  const headers = siteHeaders.map((rule, index) => {
    check(tree, `header prefix "${rule.prefix}"`, rule.prefix, faults);
    const nested = siteHeaders
      .slice(0, index)
      .filter(
        (other) =>
          other.prefix !== rule.prefix && other.prefix.startsWith(rule.prefix),
      )
      .map((other) => escapePcre(other.prefix.slice(rule.prefix.length)));
    const proxied = upstreams
      .filter(({ prefix }) => prefix.startsWith(rule.prefix))
      .map(
        ({ prefix }) =>
          `${escapePcre(prefix.slice(rule.prefix.length, -1))}(?:/|$)`,
      );
    const exclusions = [...nested, ...proxied];
    return {
      source: headerSource(vercelPattern(rule.prefix), exclusions),
      headers: rule.set.map((field) => ({
        key: field.name,
        value: vercelHeaderValue(field.value),
      })),
    };
  });

  if (tree.notFound !== undefined) check(tree, "404 page", tree.notFound, faults);
  const notFoundHeaders =
    tree.notFound === undefined ? [] : headersFor(tree, tree.notFound);

  // A miss at one of these keys gets the site's 404, forced past the file the build itself
  // wrote there (`isReservedDeployKey`, `@pagedeck/core/routing`), the way every other target
  // forces its own reserved-key rule past the origin's file.
  const reservedRoute = (src: string): ReservedRoute => ({
    src,
    status: 404,
    ...(tree.notFound === undefined ? {} : { dest: tree.notFound }),
    ...(notFoundHeaders.length === 0
      ? {}
      : { headers: headerRecord(notFoundHeaders) }),
  });

  // Before the filesystem, so a file the host holds under a prefix never answers in the app's
  // place. "src" matches the pathname without its query, and "dest" may be a full URL
  // (https://vercel.com/docs/build-output-api/v3/configuration#routes); a route with no
  // "methods" takes every method.
  const upstreamRoutes = upstreams.flatMap(({ prefix, url }): UpstreamRoute[] => {
    if (url === undefined) return [];
    const path = prefix.slice(0, -1);
    const why = prefix.startsWith(WELL_KNOWN)
      ? `Vercel answers ${WELL_KNOWN} itself ("The /.well-known path is reserved and cannot be redirected or rewritten", https://vercel.com/docs/rewrites)`
      : unexpressibleInVercelDestination(path);
    if (why !== undefined) {
      faults.push({
        kind: "unexpressible",
        line: `${treeOf(tree.domain)}'s upstream prefix "${prefix}" — ${why}`,
      });
    }
    return [{ src: `^${escapePcre(path)}(/.*)?$`, dest: `${url}${path}$1` }];
  });

  const routes: readonly (
    | ReservedRoute
    | UpstreamRoute
    | { handle: "filesystem" }
  )[] = [
    reservedRoute(`^${escapePcre(DEPLOY_MANIFEST_PATH)}$`),
    reservedRoute(`^${escapePcre(DEPLOY_DIRECTORY)}$`),
    reservedRoute(`^${escapePcre(DEPLOY_DIRECTORY)}/.*$`),
    ...upstreamRoutes,
    { handle: "filesystem" },
    // Last, after the real files: every other miss gets the same forced rule, so a 404
    // anywhere in the tree carries the 404 page's own headers rather than whichever
    // rule's "source" the missing path happens to match
    // (https://vercel.com/docs/project-configuration/vercel-json#headers reads "source"
    // against the incoming pathname, not the page a miss serves). Omitted with no 404 page,
    // so the host's own bare 404 answers, which carries no header claim.
    ...(tree.notFound === undefined ? [] : [reservedRoute("^/.*$")]),
  ];

  const contents = `${JSON.stringify(
    {
      trailingSlash: tree.trailingSlash === "always",
      cleanUrls: true,
      ...(redirects.length === 0 ? {} : { redirects }),
      ...(headers.length === 0 ? {} : { headers }),
      routes,
    },
    null,
    2,
  )}\n`;

  return [{ ...domain, role: "tree-file", path: "/vercel.json", contents }];
}
