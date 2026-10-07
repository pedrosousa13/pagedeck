import { describe, expect, it } from "vitest";

import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { compileRouting } from "./index.js";
import {
  comparable,
  interpretCloudFront,
  interpretWorker,
} from "./interpret.test-support.js";

const MANIFEST: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [],
      headers: [
        {
          prefix: "/",
          set: [
            { name: "__proto__", value: "carried" },
            { name: "X-Frame-Options", value: "DENY" },
          ],
        },
      ],
    },
  ],
};

describe("a header name that is a token and an awkward JavaScript key", () => {
  it('carries "__proto__" as a header rather than as a prototype', async () => {
    const { artifacts } = compileRouting(MANIFEST, {
      target: "cloudfront-function",
    });
    const resolution = await interpretCloudFront(artifacts, {
      path: "/en/pricing",
      found: true,
    });
    expect(resolution).toEqual({
      kind: "pass",
      headers: [
        { name: "__proto__", value: "carried" },
        { name: "x-frame-options", value: "DENY" },
      ],
    });
  });

  it('carries "__proto__" as a header on cloudflare-worker too', async () => {
    const { artifacts } = compileRouting(MANIFEST, {
      target: "cloudflare-worker",
    });
    const resolution = await interpretWorker(artifacts, {
      path: "/en/pricing",
      found: true,
    });
    expect(comparable(resolution)).toEqual({
      kind: "pass",
      headers: [
        { name: "__proto__", value: "carried" },
        { name: "x-frame-options", value: "DENY" },
      ],
    });
  });
});
