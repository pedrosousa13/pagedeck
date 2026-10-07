import { describe, expect, it } from "vitest";

import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { textOf } from "../../edge/src/conformance.test-support.js";
import { netlify } from "./index.js";

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
    expect(textOf(netlify(), root)).toBe(
      "/manifest.json /.pagedeck/unserved 404!\n/.pagedeck /.pagedeck/unserved 404!\n/.pagedeck/* /.pagedeck/unserved 404!\n/old / 301\n/old/ / 301!\n",
    );
  });
});
