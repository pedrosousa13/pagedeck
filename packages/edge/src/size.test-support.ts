import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import type { EdgeArtifact } from "./artifact.js";

export function manifestOf(count: number): RoutingManifest {
  const redirects = Array.from({ length: count }, (_unused, index) => ({
    from: `/old-${String(index).padStart(5, "0")}`,
    to: `/new-${String(index).padStart(5, "0")}`,
    status: 301 as const,
    source: "config" as const,
    via: [],
  }));
  return {
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [{ redirects, notFound: "/404", headers: [] }],
  };
}

export function bytes(artifact: EdgeArtifact): number {
  return Buffer.byteLength(artifact.contents, "utf8");
}
