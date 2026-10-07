import type { RoutingManifest } from "@pagedeck/core/routing";
import { ROUTING_VERSION } from "@pagedeck/core/routing";

export const FIXTURE: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [
        {
          from: "/en/legacy",
          to: "/en/about",
          status: 301,
          source: "config",
          via: [],
        },
        {
          // Flattened from `/en/old-docs` → `/en/docs-v1` → `/en/docs/intro`, so `/en/docs-v1` 404s.
          from: "/en/old-docs",
          to: "/en/docs/intro",
          status: 308,
          source: "config",
          via: ["/en/docs-v1"],
        },
      ],
      notFound: "/en/404",
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
          from: "/sale",
          to: "/deals",
          status: 302,
          source: "deleted-page",
          via: [],
        },
      ],
      notFound: "/shop-404",
      headers: [
        {
          prefix: "/",
          set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
        },
      ],
    },
  ],
};
