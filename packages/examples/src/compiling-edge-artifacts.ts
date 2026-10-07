import { planRouting } from "@pagedeck/core";
import type { RoutingManifest } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";
import type { EdgeArtifact } from "@pagedeck/edge";

export interface CompiledEdge {
  routing: RoutingManifest;
  artifacts: readonly EdgeArtifact[];
}

/**
 * `build: { adapter: netlify() }` is what `pagedeck build` calls on every
 * build, after it plans `routing`. This is the direct call
 * deploy-a-site.md's short note describes: the same adapter, over a routing
 * document planned the same way a build plans one, with no build in between.
 */
export function compileEdgeArtifacts(): CompiledEdge {
  const routing = planRouting({
    pages: [{ locale: "en", path: "/", output: "/en", dependencies: [] }],
    trailingSlash: "never",
  });
  return { routing, artifacts: netlify().compile(routing).artifacts };
}
