import { describe, expect, it } from "vitest";

import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { contentsOf } from "../../edge/src/conformance.test-support.js";
import { vercel } from "./index.js";

describe("the claim the adapters are checked against", () => {
  it("leaves the root alone, which has one spelling under either policy", () => {
    const root: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [
        {
          redirects: [
            { from: "/old", to: "/", status: 301, source: "config", via: [] },
          ],
          headers: [],
        },
      ],
    };
    expect(JSON.parse(contentsOf(vercel(), root, "/vercel.json")).redirects).toEqual([
      { source: "/old", destination: "/", statusCode: 301 },
      { source: "/old/", destination: "/", statusCode: 301 },
    ]);
  });
});
