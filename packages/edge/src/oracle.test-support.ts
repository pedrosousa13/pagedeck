// Test-only: it is the claim the compilers are checked against, so sharing it would make the
// check circular.
import { isReservedDeployKey } from "@pagedeck/core/routing";
import type {
  HeaderField,
  RedirectStatus,
  RoutingManifest,
  RoutingTree,
  TrailingSlash,
} from "@pagedeck/core/routing";

/** `found` is the origin's answer, which no host's config holds, so the test states it. */
export interface EdgeRequest {
  /** The tree the host serves, absent for the default one. */
  domain?: string;
  /** Tree-relative, spelled the way `Page.output` is. */
  path: string;
  found: boolean;
}

// The 404 page carries its own path's set whatever was asked for: one nginx location cannot
// vary by request (#559). A host's bare 404 carries no claim.
export type Resolution =
  | {
      kind: "redirect";
      to: string;
      status: RedirectStatus;
      headers: readonly HeaderField[];
    }
  | { kind: "not-found"; document: string; headers: readonly HeaderField[] }
  /**
   * The host's own 404: the tree configured no 404 page. An interpreter that can see its
   * headers reports them, and `comparable` drops them: the claim is about the 404 page.
   */
  | { kind: "not-found"; headers?: readonly HeaderField[] }
  | { kind: "pass"; headers: readonly HeaderField[] };

function treeFor(
  manifest: RoutingManifest,
  domain: string | undefined,
): RoutingTree | undefined {
  return manifest.trees.find((tree) => tree.domain === domain);
}

function canonicalize(path: string, trailingSlash: TrailingSlash): string {
  if (path === "/") return path;
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  return trailingSlash === "always" ? `${bare}/` : bare;
}

// Redirects before the origin; `planRouting` refuses a redirect from a routed page, so one
// oracle holds for every host; `servedStatus` is where one narrows what the document declares.
export function resolveRequest(
  manifest: RoutingManifest,
  request: EdgeRequest,
  servedStatus: (status: RedirectStatus) => RedirectStatus = (status) => status,
  noSlashRedirects = false,
): Resolution {
  const tree = treeFor(manifest, request.domain);
  if (tree === undefined) return { kind: "pass", headers: [] };

  if (isReservedDeployKey(request.path)) return notFound(tree);

  const redirect = tree.redirects.find((rule) => rule.from === request.path);
  // `via` is an audit column; answering it would reinstate the hop flattening removed.
  if (redirect !== undefined) {
    return {
      kind: "redirect",
      to: redirect.to,
      status: servedStatus(redirect.status),
      headers: headersFor(tree, request.path),
    };
  }

  // Claimed here, not read from `normalize.ts`, so the comparison is not circular.
  const canonical = canonicalize(request.path, manifest.site.trailingSlash);
  if (canonical !== request.path) {
    const aliased = tree.redirects.find((rule) => rule.from === canonical);
    if (aliased !== undefined) {
      return {
        kind: "redirect",
        to: aliased.to,
        status: servedStatus(aliased.status),
        headers: headersFor(tree, request.path),
      };
    }
    if (
      !noSlashRedirects &&
      tree.redirects.some(
        (rule) => rule.to === canonical && rule.file !== true,
      )
    ) {
      return {
        kind: "redirect",
        to: canonical,
        status: servedStatus(308),
        headers: headersFor(tree, request.path),
      };
    }
  }

  if (!request.found) return notFound(tree);

  return { kind: "pass", headers: headersFor(tree, request.path) };
}

// First match, no merge: `add_header` in an nginx location replaces rather than inherits.
function headersFor(tree: RoutingTree, path: string): readonly HeaderField[] {
  const rule = tree.headers.find((candidate) =>
    path.startsWith(candidate.prefix),
  );
  return rule === undefined ? [] : rule.set;
}

function notFound(tree: RoutingTree): Resolution {
  return tree.notFound === undefined
    ? { kind: "not-found" }
    : {
        kind: "not-found",
        document: tree.notFound,
        headers: headersFor(tree, tree.notFound),
      };
}

/** The set the document gives the requested path itself, whatever the request resolves to. */
export function headersAt(
  manifest: RoutingManifest,
  request: EdgeRequest,
): readonly HeaderField[] {
  const tree = treeFor(manifest, request.domain);
  return tree === undefined ? [] : headersFor(tree, request.path);
}
