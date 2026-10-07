// Exact rows per address, not a site-wide pattern: not every host's format can express one, and
// every adapter must agree. The 404 page is left out, since a host may serve it only internally.
import type {
  RedirectStatus,
  ResolvedRedirect,
  RoutingTree,
  TrailingSlash,
} from "@pagedeck/core/routing";

/**
 * The path is one the author never typed: never quote it in a refusal, and force the row
 * past the origin's own document.
 */
export interface CompiledRedirect extends ResolvedRedirect {
  normalizing: boolean;
}

export interface CompiledTree extends Omit<RoutingTree, "redirects"> {
  redirects: readonly CompiledRedirect[];
  /** The site's policy, folded in here too: an adapter that cannot serve one reads it per tree. */
  trailingSlash: TrailingSlash;
}

function otherSpelling(
  path: string,
  trailingSlash: TrailingSlash,
): string | undefined {
  if (trailingSlash === "never") return path === "/" ? undefined : `${path}/`;
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  return bare === "" ? undefined : bare;
}

// First writer wins and authored rules are written first, so a derived row never replaces
// one. Re-sorted, because the compilers rely on sorted input.
export function compiledTree(
  tree: RoutingTree,
  trailingSlash: TrailingSlash,
): CompiledTree {
  const byFrom = new Map<string, CompiledRedirect>(
    tree.redirects.map((rule) => [rule.from, { ...rule, normalizing: false }]),
  );

  const derive = (
    from: string | undefined,
    to: string,
    status: RedirectStatus,
    source: ResolvedRedirect["source"],
  ): void => {
    if (from === undefined || byFrom.has(from)) return;
    byFrom.set(from, { from, to, status, source, via: [], normalizing: true });
  };

  for (const rule of tree.redirects) {
    // Answers what the source answers rather than redirecting to it, which would add a hop.
    derive(
      otherSpelling(rule.from, trailingSlash),
      rule.to,
      rule.status,
      rule.source,
    );
    // 308: a page's canonical spelling is permanent. A file target (#553) has one spelling.
    if (rule.file !== true)
      derive(otherSpelling(rule.to, trailingSlash), rule.to, 308, rule.source);
  }

  return {
    ...tree,
    redirects: [...byFrom.values()].sort((a, b) =>
      a.from === b.from ? 0 : a.from < b.from ? -1 : 1,
    ),
    trailingSlash,
  };
}
