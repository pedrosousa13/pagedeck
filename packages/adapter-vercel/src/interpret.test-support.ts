import type { HeaderField, RedirectStatus } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { find, forTree } from "../../edge/src/interpret.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";

interface VercelRedirect {
  source: string;
  destination: string;
  statusCode: RedirectStatus;
}

interface VercelHeaderRule {
  source: string;
  headers: readonly { key: string; value: string }[];
}

interface VercelRoute {
  src?: string;
  status?: number;
  dest?: string;
  headers?: Record<string, string>;
  handle?: "filesystem";
}

interface VercelConfig {
  trailingSlash: boolean;
  cleanUrls: boolean;
  redirects?: readonly VercelRedirect[];
  headers?: readonly VercelHeaderRule[];
  routes: readonly VercelRoute[];
}

function configFor(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
): VercelConfig {
  const tree = forTree(artifacts, domain);
  const file = find(tree, "/vercel.json");
  if (file === undefined) throw new Error("no vercel.json");
  return JSON.parse(file.contents) as VercelConfig;
}

// The inverse of `headerSource` in `./vercel.js`: pulls the prefix and the excluded sibling
// prefixes back out of the "<prefix>:rest((?!a)(?!b).*)" shape it writes.
function parseHeaderSource(source: string): { prefix: string; exclusions: string[] } {
  const at = source.indexOf(":rest(");
  const prefix = source.slice(0, at);
  const inner = source.slice(at + ":rest(".length, -".*)".length);
  const exclusions = [...inner.matchAll(/\(\?!([^)]*)\)/g)].map(
    (match) => match[1] ?? "",
  );
  return { prefix, exclusions };
}

function headersForPath(
  config: VercelConfig,
  path: string,
): readonly HeaderField[] {
  for (const rule of config.headers ?? []) {
    const { prefix, exclusions } = parseHeaderSource(rule.source);
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (exclusions.some((excluded) => rest.startsWith(excluded))) continue;
    return rule.headers.map((field) => ({ name: field.key, value: field.value }));
  }
  return [];
}

function fromRoute(route: VercelRoute): Resolution {
  if (route.dest === undefined) return { kind: "not-found" };
  return {
    kind: "not-found",
    document: route.dest,
    headers: Object.entries(route.headers ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  };
}

// Vercel's own `trailingSlash` setting exempts a path whose last segment holds a "." —
// https://vercel.com/docs/project-configuration/vercel-json#trailingslash.
function extensioned(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".");
}

function canonicalSpelling(path: string, trailingSlash: boolean): string {
  if (path === "/") return path;
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  if (extensioned(bare)) return path;
  return trailingSlash ? `${bare}/` : bare;
}

export function interpretVercel(
  artifacts: readonly EdgeArtifact[],
  request: EdgeRequest,
): Resolution {
  const config = configFor(artifacts, request.domain);
  const handleIndex = config.routes.findIndex((route) => route.handle !== undefined);
  const preFilesystem = config.routes.slice(0, handleIndex);
  const postFilesystem = config.routes.slice(handleIndex + 1);

  const reserved = preFilesystem.find(
    (route) => route.src !== undefined && new RegExp(route.src).test(request.path),
  );
  if (reserved !== undefined) return fromRoute(reserved);

  const exact = (config.redirects ?? []).find(
    (rule) => rule.source === request.path,
  );
  if (exact !== undefined) {
    return {
      kind: "redirect",
      to: exact.destination,
      status: exact.statusCode,
      headers: headersForPath(config, request.path),
    };
  }

  const canonical = canonicalSpelling(request.path, config.trailingSlash);
  if (canonical !== request.path) {
    const aliased = (config.redirects ?? []).find(
      (rule) => rule.source === canonical,
    );
    if (aliased !== undefined) {
      return {
        kind: "redirect",
        to: aliased.destination,
        status: aliased.statusCode,
        headers: headersForPath(config, request.path),
      };
    }
    const toCanonical = (config.redirects ?? []).some(
      (rule) => rule.destination === canonical,
    );
    if (toCanonical) {
      return {
        kind: "redirect",
        to: canonical,
        status: 308,
        headers: headersForPath(config, request.path),
      };
    }
  }

  if (!request.found) {
    const fallback = postFilesystem.find(
      (route) => route.src !== undefined && new RegExp(route.src).test(request.path),
    );
    return fallback === undefined ? { kind: "not-found" } : fromRoute(fallback);
  }

  return { kind: "pass", headers: headersForPath(config, request.path) };
}
