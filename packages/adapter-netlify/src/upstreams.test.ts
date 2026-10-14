import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest, UpstreamRoute } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { netlify } from "./index.js";

function withUpstreams(
  byTree: (domain: string | undefined) => readonly UpstreamRoute[],
): RoutingManifest {
  return {
    ...FIXTURE,
    trees: FIXTURE.trees.map((tree) => {
      const upstreams = byTree(tree.domain);
      return upstreams.length === 0 ? tree : { ...tree, upstreams };
    }),
  };
}

function contentsOf(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
  path: string,
): string | undefined {
  return artifacts.find(
    (artifact) => artifact.domain === domain && artifact.path === path,
  )?.contents;
}

describe("upstream prefixes", () => {
  it("refuses every prefix that names no url, in one report", () => {
    const manifest = withUpstreams((domain) =>
      domain === undefined
        ? [
            { prefix: "/api/" },
            { prefix: "/auth/", url: "https://auth.example" },
            { prefix: "/hooks/" },
          ]
        : [{ prefix: "/cart/" }],
    );
    expect(() => netlify().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "netlify": 2 trees send prefixes to apps with no url, which this target needs to reach each app — set url on each to the https origin the deployed app answers at, such as "https://app.example":
  the default tree's prefixes "/api/", "/hooks/" (build.routing.upstreams)
  the "shop.example" tree's prefix "/cart/" (build.routing.upstreams)`,
      ),
    );
  });

  // https://docs.netlify.com/routing/redirects/rewrites-proxies/ : "/api/*
  // https://api.example.com/:splat 200", forced with "!". The exact row covers the unslashed
  // prefix, which the docs do not say a splat matches.
  it("proxies each prefix to its app, after the reserved keys and before the redirects", () => {
    const { artifacts } = netlify().compile(
      withUpstreams((domain) =>
        domain === undefined
          ? [
              { prefix: "/api/", url: "https://app.example" },
              { prefix: "/auth/v2/", url: "https://auth.example" },
            ]
          : [{ prefix: "/cart/", url: "https://cart.example" }],
      ),
    );
    expect(contentsOf(artifacts, undefined, "/_redirects")).toBe(`/manifest.json /en/404 404!
/.pagedeck /en/404 404!
/.pagedeck/* /en/404 404!
/api/* https://app.example/api/:splat 200!
/api https://app.example/api 200!
/auth/v2/* https://auth.example/auth/v2/:splat 200!
/auth/v2 https://auth.example/auth/v2 200!
/en/legacy /en/about 301
/en/legacy/ /en/about 301!
/en/old-docs /en/docs/intro 301
/en/old-docs/ /en/docs/intro 301!
/* /en/404 404
`);
    expect(contentsOf(artifacts, "shop.example", "/_redirects")).toBe(`/manifest.json /shop-404 404!
/.pagedeck /shop-404 404!
/.pagedeck/* /shop-404 404!
/cart/* https://cart.example/cart/:splat 200!
/cart https://cart.example/cart 200!
/sale /deals 302
/sale/ /deals 302!
/* /shop-404 404
`);
  });

  // https://docs.netlify.com/routing/redirects/rewrites-proxies/ : "If you are proxying content
  // to your site, custom headers will not be applied to that content."
  it("leaves the header file as it is, since Netlify sets no header on proxied content", () => {
    const plain = netlify().compile(FIXTURE).artifacts;
    const routed = netlify().compile(
      withUpstreams(() => [{ prefix: "/api/", url: "https://app.example" }]),
    ).artifacts;
    for (const domain of [undefined, "shop.example"]) {
      expect(contentsOf(routed, domain, "/_headers")).toBe(
        contentsOf(plain, domain, "/_headers"),
      );
    }
  });

  it("writes a tree with no upstreams byte for byte as before", () => {
    const plain = netlify().compile(FIXTURE).artifacts;
    const routed = netlify().compile(
      withUpstreams((domain) =>
        domain === undefined ? [] : [{ prefix: "/cart/", url: "https://cart.example" }],
      ),
    ).artifacts;
    expect(routed.filter((artifact) => artifact.domain === undefined)).toEqual(
      plain.filter((artifact) => artifact.domain === undefined),
    );
  });

  it('refuses a prefix holding ":", which Netlify reads as a placeholder', () => {
    const manifest = withUpstreams((domain) =>
      domain === undefined ? [{ prefix: "/a:b/", url: "https://app.example" }] : [],
    );
    expect(() => netlify().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 value cannot be expressed by this target — change each value as its line says, or compile a target that can express it:
  the default tree's upstream prefix "/a:b/" — Netlify reads ":" in a path pattern as the start of a placeholder, and offers no escape for a literal one`,
      ),
    );
  });

  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ : a ":"-led part is a
  // placeholder, with no escape, so the port in a destination would be read as one.
  it("refuses a url with a port, which Netlify would read as a placeholder", () => {
    const manifest = withUpstreams((domain) =>
      domain === undefined
        ? [
            { prefix: "/api/", url: "https://app.example:8443" },
            { prefix: "/auth/", url: "https://auth.example" },
          ]
        : [{ prefix: "/cart/", url: "https://cart.example:8080" }],
    );
    expect(() => netlify().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "netlify": 2 values cannot be expressed by this target — change each value as its line says, or compile a target that can express it:
  the default tree's upstream prefix "/api/" — its url "https://app.example:8443" names port 8443, and Netlify reads ":" in a destination as the start of a placeholder, and offers no escape for a literal one
  the "shop.example" tree's upstream prefix "/cart/" — its url "https://cart.example:8080" names port 8080, and Netlify reads ":" in a destination as the start of a placeholder, and offers no escape for a literal one`,
      ),
    );
  });
});
