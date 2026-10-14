import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { vercel } from "./index.js";

describe("upstream prefixes", () => {
  it("refuses every tree that sends a prefix to an app, in one report", () => {
    const manifest: RoutingManifest = {
      ...FIXTURE,
      trees: FIXTURE.trees.map((tree) => ({
        ...tree,
        upstreams:
          tree.domain === undefined
            ? [{ prefix: "/api/" }, { prefix: "/auth/", url: "https://auth.example" }]
            : [{ prefix: "/cart/" }],
      })),
    };
    expect(() => vercel().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "vercel": 2 trees send prefixes to an app, which this target cannot route — deploy with cloudflarePages(), the one adapter that routes a prefix to an app so far, or remove build.routing.upstreams and route each prefix in the host's own configuration:
  the default tree's prefixes "/api/", "/auth/" (build.routing.upstreams)
  the "shop.example" tree's prefix "/cart/" (build.routing.upstreams)`,
      ),
    );
  });
});
