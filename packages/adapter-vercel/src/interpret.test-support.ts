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

// Vercel documents `source` only as "a pattern"; this assumes path-to-regexp, with a regex inside
// `:name(…)` (#37, https://vercel.com/docs/project-configuration/vercel-json#header-object-definition).
function sourcePattern(source: string): RegExp {
  let pattern = "";
  let at = 0;
  while (at < source.length) {
    const group = /^:\w+\(/.exec(source.slice(at));
    if (group === null) {
      const character = source[at] ?? "";
      if (/[:()*+?{}\\]/.test(character)) {
        throw new Error(
          `Header source "${source}": holds path-to-regexp syntax ${JSON.stringify(character)} at ${String(at)} that sourcePattern does not model — model it in sourcePattern, or stop emitting it from vercel()`,
        );
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
      if (character === undefined) {
        throw new Error(
          `Header source "${source}": holds an unclosed group — close it with ")" in vercel()'s headerSource`,
        );
      }
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

/** The site's headers Vercel's `headers` rules give `path`, whatever answers it. */
export function vercelHeadersAt(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
  path: string,
): readonly HeaderField[] {
  return headersForPath(configFor(artifacts, domain), path);
}

// "src" matches "each incoming pathname (excluding querystring)"
// (https://vercel.com/docs/build-output-api/v3/configuration#routes), and "the `src` property is
// case-insensitive" (https://vercel.com/docs/project-configuration/vercel-json#case-sensitivity).
function matchRoute(
  routes: readonly VercelRoute[],
  pathname: string,
): { route: VercelRoute; match: RegExpExecArray } | undefined {
  for (const route of routes) {
    if (route.src === undefined) continue;
    const match = new RegExp(route.src, "i").exec(pathname);
    if (match !== null) return { route, match };
  }
  return undefined;
}

const UPSTREAM_SOURCE = /^\^(.*)\(\/\.\*\)\?\$$/s;

// Assumes Vercel substitutes "" for "$1" when the group took no part in the match: "dest" is
// documented only as embedding "capture groups as $1, $2".
function fromUpstream(
  route: VercelRoute & { dest: string },
  match: RegExpExecArray,
  pathname: string,
): Resolution {
  const target = route.dest.replace("$1", match[1] ?? "");
  const { origin } = new URL(target);
  if (target !== `${origin}${pathname}`) {
    throw new Error(
      `Route "${String(route.src)}" sends "${pathname}" to "${target}" — vercel() must send the request's own path to the app's origin`,
    );
  }
  const escaped = UPSTREAM_SOURCE.exec(route.src ?? "")?.[1];
  if (escaped === undefined) {
    throw new Error(
      `Route "${String(route.src)}" sends to "${route.dest}" from a "src" interpretVercel does not read — model it here, or stop emitting it from vercel()`,
    );
  }
  return {
    kind: "upstream",
    prefix: `${escaped.replace(/\\(.)/gs, "$1")}/`,
    url: origin,
  };
}

function fromRoute(
  { route, match }: { route: VercelRoute; match: RegExpExecArray },
  pathname: string,
): Resolution {
  if (route.dest !== undefined && /^https:\/\//.test(route.dest)) {
    return fromUpstream({ ...route, dest: route.dest }, match, pathname);
  }
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

  const pathname = request.path.replace(/[?#].*$/s, "");
  const early = matchRoute(preFilesystem, pathname);
  if (early !== undefined) return fromRoute(early, pathname);

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
    const fallback = matchRoute(postFilesystem, pathname);
    return fallback === undefined
      ? { kind: "not-found" }
      : fromRoute(fallback, pathname);
  }

  return { kind: "pass", headers: headersForPath(config, request.path) };
}
