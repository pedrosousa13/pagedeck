// Not `describeConformance` from `@pagedeck/edge`: every one of its common fixtures is
// trailingSlash: "never", which this adapter refuses (refusal.test.ts), and most of its
// assertions exercise that policy directly. Rewriting those fixtures to "always" would be a
// change to the shared edge package reaching every other adapter's locked golden output, not a
// change this issue's scope covers — see the final report. This file covers the same underlying
// claims (one document, one behavior; a non-canonical spelling; determinism; the whole security
// set) with "always" manifests, reusing the host-agnostic oracle (`resolveRequest`) `describeConformance`
// itself is checked against.
import { describe, expect, it } from "vitest";

import { ROUTING_VERSION, SECURITY_HEADERS } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";
import { ALWAYS_FIXTURE } from "./fixture.test-support.js";
import { cloudflarePages } from "./index.js";
import { interpretCloudflarePages } from "./interpret.test-support.js";

const adapter = cloudflarePages();

async function answer(manifest: RoutingManifest, request: EdgeRequest): Promise<Resolution> {
  return comparable(interpretCloudflarePages(adapter.compile(manifest).artifacts, request));
}

// No generic "missing document" case: an unmatched request is not in `_redirects` at all, so
// Cloudflare's own nearest-404.html lookup serves it, not anything this adapter writes — see the
// unverified host fact in docs/deploy-recipe.md. The cases below are all ones `_redirects` or
// `_headers` actually governs.
const REQUESTS: readonly (EdgeRequest & { what: string })[] = [
  { what: "an exact redirect", path: "/en/legacy/", found: false },
  { what: "a redirect that kept its first hop's status", path: "/en/old-docs/", found: false },
  { what: "the non-canonical spelling of a redirect source", path: "/en/legacy", found: true },
  { what: "the non-canonical spelling of a live page", path: "/en/about", found: true },
  { what: "the canonical spelling of a live page", path: "/en/about/", found: true },
  { what: "a path no rule names", path: "/de/index/", found: true },
  { what: "a redirect on the second tree", domain: "shop.example", path: "/sale/", found: false },
  { what: "a header on the second tree", domain: "shop.example", path: "/deals/", found: true },
];

describe("one document, this adapter, one behavior", () => {
  for (const request of REQUESTS) {
    it(`answers ${request.what} the way the document says`, async () => {
      expect(await answer(ALWAYS_FIXTURE, request)).toEqual(
        comparable(resolveRequest(ALWAYS_FIXTURE, request)),
      );
    });
  }
});

describe("compile is deterministic", () => {
  it("compiles to identical text twice", () => {
    expect(adapter.compile(ALWAYS_FIXTURE)).toEqual(adapter.compile(ALWAYS_FIXTURE));
  });
});

describe("a site's whole security set, HSTS and CSP included", () => {
  const policy = "default-src 'self'; script-src 'self' 'sha256-AbC+/='";
  const hardened: RoutingManifest = {
    version: ROUTING_VERSION,
    site: { trailingSlash: "always" },
    trees: [
      {
        redirects: [{ from: "/old/", to: "/new/", status: 301, source: "config", via: [] }],
        notFound: "/404/",
        headers: [
          {
            prefix: "/",
            set: [
              ...SECURITY_HEADERS,
              { name: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
              { name: "Content-Security-Policy", value: policy },
            ],
          },
        ],
      },
    ],
  };

  it("answers a page with all five fields, as the document says", async () => {
    const request = { path: "/new/", found: true };
    const claim = comparable(resolveRequest(hardened, request));
    expect(
      ("headers" in claim ? claim.headers : undefined)?.map((field) => field.name),
    ).toEqual([
      "content-security-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
    ]);
    expect(await answer(hardened, request)).toEqual(claim);
  });
});
