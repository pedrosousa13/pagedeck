import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { cloudfront } from "./index.js";

describe("compile refusals", () => {
  it("names the artifact, its size and its limit when one overflows", () => {
    // Reachable only by forcing the limit: the dataset form is O(1) in rule count.
    expect(() =>
      cloudfront({ limits: { function: 64 } }).compile(FIXTURE),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudfront-function": 4 artifacts exceed their size limit — reduce the rule set, or raise the limit if the host's is higher:
  the default tree's viewer-request function — 2040 bytes, limit 64
  the default tree's viewer-response function — 1022 bytes, limit 64
  the "shop.example" tree's viewer-request function — 1895 bytes, limit 64
  the "shop.example" tree's viewer-response function — 879 bytes, limit 64`,
      ),
    );
  });
});
