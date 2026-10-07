// Test-only: `@pagedeck/edge`'s own fixture (`packages/edge/src/fixture.test-support.ts`) is
// trailingSlash: "never", which this adapter refuses (see refusal.test.ts), so every test here
// needs its own "always" equivalent rather than the shared one.
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

export const ALWAYS_FIXTURE: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "always" },
  trees: [
    {
      redirects: [
        {
          from: "/en/legacy/",
          to: "/en/about/",
          status: 301,
          source: "config",
          via: [],
        },
        {
          from: "/en/old-docs/",
          to: "/en/docs/intro/",
          status: 308,
          source: "config",
          via: ["/en/docs-v1/"],
        },
      ],
      notFound: "/en/404/",
      headers: [
        {
          prefix: "/en/docs/",
          set: [{ name: "X-Frame-Options", value: "DENY" }],
        },
        {
          prefix: "/en/",
          set: [
            { name: "X-Content-Type-Options", value: "nosniff" },
            {
              name: "Referrer-Policy",
              value: "strict-origin-when-cross-origin",
            },
          ],
        },
      ],
    },
    {
      domain: "shop.example",
      redirects: [
        {
          from: "/sale/",
          to: "/deals/",
          status: 302,
          source: "deleted-page",
          via: [],
        },
      ],
      notFound: "/shop-404/",
      headers: [
        {
          prefix: "/",
          set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
        },
      ],
    },
  ],
};

export const EN_HEADERS = [
  { name: "X-Content-Type-Options", value: "nosniff" },
  { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

export const BARE: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "always" },
  trees: [
    {
      redirects: [],
      headers: [
        {
          prefix: "/.pagedeck/manifests/",
          set: [{ name: "Cache-Control", value: "public, max-age=60" }],
        },
        {
          prefix: "/",
          set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
        },
      ],
    },
  ],
};
