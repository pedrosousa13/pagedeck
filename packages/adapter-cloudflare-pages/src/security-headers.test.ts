import { describe, expect, it } from "vitest";

import { ROUTING_VERSION, SECURITY_HEADERS } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { cloudflarePages } from "./index.js";

const SECURITY_MANIFEST: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "always" },
  trees: [
    {
      redirects: [],
      notFound: "/404/",
      headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
    },
  ],
};

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches _headers as one block, no detach needed since it has no ancestor", () => {
    const output = cloudflarePages().compile(SECURITY_MANIFEST);
    const file = output.artifacts.find((artifact) => artifact.path === "/_headers");
    expect(file?.contents).toBe(
      [
        "/*",
        "  X-Content-Type-Options: nosniff",
        "  X-Frame-Options: DENY",
        "  Referrer-Policy: strict-origin-when-cross-origin",
        "",
      ].join("\n"),
    );
  });
});
