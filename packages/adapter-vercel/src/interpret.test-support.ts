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

// Path-to-regexp, as Vercel reads `source`: literal text outside a group, a regex inside `:name(…)` (#37,
// https://vercel.com/docs/project-configuration/vercel-json#negative-lookahead).
function sourcePattern(source: string): RegExp {
  let pattern = "";
  let at = 0;
  while (at < source.length) {
    const group = /^:\w+\(/.exec(source.slice(at));
    if (group === null) {
      const character = source[at] ?? "";
      if (/[:()*+?{}\\]/.test(character)) {
        throw new Error(`unmodelled path-to-regexp syntax at ${String(at)} in "${source}"`);
      }
      pattern += character.replace(/[.^$|[\]]/, "\\$&");
      at += 1;
      continue;
    }
    at += group[0].length;
    let depth = 1;
    const start = at;
    for (; depth > 0; at += 1) {
      const character = source[at];
      if (character === undefined) throw new Error(`unclosed group in "${source}"`);
      if (character === "\\") at += 1;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    pattern += `(${source.slice(start, at - 1)})`;
  }
  return new RegExp(`^${pattern}$`);
}

// Every matching rule applies, not only the first, as Vercel applies them.
function headersForPath(
  config: VercelConfig,
  path: string,
): readonly HeaderField[] {
  return (config.headers ?? [])
    .filter((rule) => sourcePattern(rule.source).test(path))
    .flatMap((rule) =>
      rule.headers.map((field) => ({ name: field.key, value: field.value })),
    );
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
