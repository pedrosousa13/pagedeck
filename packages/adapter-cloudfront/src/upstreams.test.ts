import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest, UpstreamRoute } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { cloudfront } from "./index.js";
import { interpretCloudFront } from "./interpret.test-support.js";

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

function ofTree(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
): readonly EdgeArtifact[] {
  return artifacts.filter((artifact) => artifact.domain === domain);
}

function contentsOf(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
  path: string,
): string | undefined {
  return ofTree(artifacts, domain).find((artifact) => artifact.path === path)
    ?.contents;
}

function behavior(PathPattern: string, TargetOriginId: string): object {
  return {
    PathPattern,
    TargetOriginId,
    ViewerProtocolPolicy: "redirect-to-https",
    AllowedMethods: {
      Quantity: 7,
      Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
    },
    CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    Compress: false,
  };
}

function origin(Id: string, DomainName: string, HTTPSPort: number): object {
  return {
    Id,
    DomainName,
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort,
      OriginProtocolPolicy: "https-only",
      OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
    },
  };
}

function asWritten(config: object): string {
  return `${JSON.stringify(config, null, 2)}\n`;
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
    expect(() => cloudfront().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudfront-function": 2 trees send prefixes to apps with no url, which this target needs to reach each app — set url on each to the https origin the deployed app answers at, such as "https://app.example":
  the default tree's prefixes "/api/", "/hooks/" (build.routing.upstreams)
  the "shop.example" tree's prefix "/cart/" (build.routing.upstreams)`,
      ),
    );
  });

  it("writes an origin and two uncached behaviors per prefix, each tree on its own", () => {
    const { artifacts } = cloudfront().compile(
      withUpstreams((domain) =>
        domain === undefined
          ? [
              { prefix: "/api/", url: "https://app.example" },
              { prefix: "/auth/v2/", url: "https://auth.example" },
            ]
          : [{ prefix: "/cart/", url: "https://cart.example:8443" }],
      ),
    );
    expect(
      ofTree(artifacts, undefined).map(({ path, role }) => ({ path, role })),
    ).toEqual([
      { path: "routing.request.js", role: "function" },
      { path: "routing.response.js", role: "function" },
      { path: "error-responses.json", role: "distribution-config" },
      { path: "upstreams.json", role: "distribution-config" },
    ]);
    expect(contentsOf(artifacts, undefined, "upstreams.json")).toBe(
      asWritten({
        Origins: {
          Quantity: 2,
          Items: [
            origin("pagedeck-upstream/api/", "app.example", 443),
            origin("pagedeck-upstream/auth/v2/", "auth.example", 443),
          ],
        },
        CacheBehaviors: {
          Quantity: 4,
          Items: [
            behavior("/api", "pagedeck-upstream/api/"),
            behavior("/api/*", "pagedeck-upstream/api/"),
            behavior("/auth/v2", "pagedeck-upstream/auth/v2/"),
            behavior("/auth/v2/*", "pagedeck-upstream/auth/v2/"),
          ],
        },
      }),
    );
    expect(contentsOf(artifacts, "shop.example", "upstreams.json")).toBe(
      asWritten({
        Origins: {
          Quantity: 1,
          Items: [origin("pagedeck-upstream/cart/", "cart.example", 8443)],
        },
        CacheBehaviors: {
          Quantity: 2,
          Items: [
            behavior("/cart", "pagedeck-upstream/cart/"),
            behavior("/cart/*", "pagedeck-upstream/cart/"),
          ],
        },
      }),
    );
  });

  // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern :
  // "Path patterns are case-sensitive".
  it("sends each tree's prefixes to its own origin, port included, and nothing else", async () => {
    const { artifacts } = cloudfront().compile(
      withUpstreams((domain) =>
        domain === undefined
          ? [{ prefix: "/api/", url: "https://app.example" }]
          : [{ prefix: "/cart/", url: "https://cart.example:8443" }],
      ),
    );
    const answer = (domain: string | undefined, path: string) =>
      interpretCloudFront(artifacts, {
        ...(domain === undefined ? {} : { domain }),
        path,
        found: false,
      });
    expect(await answer("shop.example", "/cart/items?page=2")).toEqual({
      kind: "upstream",
      prefix: "/cart/",
      url: "https://cart.example:8443",
    });
    expect(await answer("shop.example", "/cart")).toEqual({
      kind: "upstream",
      prefix: "/cart/",
      url: "https://cart.example:8443",
    });
    expect((await answer("shop.example", "/api/signup")).kind).toBe("not-found");
    expect((await answer(undefined, "/API/signup")).kind).toBe("not-found");
    expect((await answer(undefined, "/cart/items")).kind).toBe("not-found");
  });

  it("leaves every other artifact byte for byte as it was", () => {
    const plain = cloudfront().compile(FIXTURE).artifacts;
    const routed = cloudfront().compile(
      withUpstreams((domain) =>
        domain === undefined ? [] : [{ prefix: "/cart/", url: "https://cart.example" }],
      ),
    ).artifacts;
    expect(plain.some((artifact) => artifact.path === "upstreams.json")).toBe(false);
    expect(
      routed.filter((artifact) => artifact.path !== "upstreams.json"),
    ).toEqual(plain);
  });

  it("refuses what no CloudFront origin or cache behavior can hold, in one report", () => {
    const many = Array.from({ length: 38 }, (_, at) => ({
      prefix: `/app${String(at)}/`,
      url: "https://app.example",
    }));
    const manifest = withUpstreams((domain) =>
      domain === undefined
        ? [
            { prefix: "/api/", url: "https://203.0.113.7" },
            { prefix: "/v6/", url: "https://[2001:db8::1]:8443" },
            { prefix: "/low/", url: "https://app.example:444" },
            { prefix: "/café,menu/", url: "https://app.example" },
            { prefix: `/${"a".repeat(253)}/`, url: "https://app.example" },
          ]
        : many,
    );
    expect(() => cloudfront().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudfront-function": 4 values cannot be expressed by this target — change each value as its line says, or compile a target that can express it:
  the default tree's upstream prefix "/api/" — its url "https://203.0.113.7" names an IP address, and CloudFront takes only a DNS name as a custom origin's domain name
  the default tree's upstream prefix "/v6/" — its url "https://[2001:db8::1]:8443" names an IP address, and CloudFront takes only a DNS name as a custom origin's domain name
  the default tree's upstream prefix "/low/" — its url "https://app.example:444" names port 444, and CloudFront connects to a custom origin only on port 80, 443 or 1024 to 65535
  the default tree's upstream prefix "/café,menu/" — CloudFront's path patterns hold only letters, digits and _ - . $ / ~ " ' @ : + &, so no cache behavior can match "é", ","

Edge target "cloudfront-function": 2 values exceed a limit this target documents — reduce the rule set, or compile a target whose documented limit is higher:
  the default tree's upstream prefix "/${"a".repeat(253)}/" — its path pattern "/${"a".repeat(253)}/*" is 256 characters, and CloudFront's limit is 255
  the "shop.example" tree's upstream prefixes — 38 prefixes need 76 cache behaviors, and CloudFront's default quota is 75 per distribution; set cloudfront({ limits: { cacheBehaviors } }) if your account's is higher`,
      ),
    );
  });

  it("compiles past the default quota when the account's is raised, and holds the raised one", () => {
    const manifest = (count: number) =>
      withUpstreams((domain) =>
        domain === undefined
          ? []
          : Array.from({ length: count }, (_, at) => ({
              prefix: `/app${String(at)}/`,
              url: "https://app.example",
            })),
      );
    const raised = cloudfront({ limits: { cacheBehaviors: 100 } });
    const config = JSON.parse(
      contentsOf(raised.compile(manifest(38)).artifacts, "shop.example", "upstreams.json") ??
        "{}",
    ) as { CacheBehaviors: { Quantity: number } };
    expect(config.CacheBehaviors.Quantity).toBe(76);
    expect(() => raised.compile(manifest(51))).toThrow(
      new ConfigError(
        `Edge target "cloudfront-function": 1 value exceeds a limit this target documents — reduce the rule set, or compile a target whose documented limit is higher:
  the "shop.example" tree's upstream prefixes — 51 prefixes need 102 cache behaviors, and cloudfront({ limits: { cacheBehaviors } }) sets 100 per distribution`,
      ),
    );
  });
});
