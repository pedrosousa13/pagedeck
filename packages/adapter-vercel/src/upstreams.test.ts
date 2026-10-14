import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest, RoutingTree } from "@pagedeck/core/routing";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { vercel } from "./index.js";
import { vercelHeadersAt } from "./interpret.test-support.js";

const NOSNIFF = { name: "X-Content-Type-Options", value: "nosniff" };

function manifestOf(tree: RoutingTree): RoutingManifest {
  return { ...FIXTURE, trees: [tree] };
}

const ROUTED = manifestOf({
  redirects: [],
  notFound: "/en/404",
  headers: [{ prefix: "/", set: [NOSNIFF] }],
  upstreams: [
    { prefix: "/a.b/", url: "https://dots.example" },
    { prefix: "/api/", url: "https://app.example" },
  ],
});

function vercelJson(manifest: RoutingManifest): string {
  const file = vercel()
    .compile(manifest)
    .artifacts.find((artifact) => artifact.path === "/vercel.json");
  if (file === undefined) throw new Error("no /vercel.json for vercel");
  return file.contents;
}

describe("upstream prefixes", () => {
  it("refuses every tree that sends a prefix to an app with no url, in one report", () => {
    const manifest: RoutingManifest = {
      ...FIXTURE,
      trees: FIXTURE.trees.map((tree) => ({
        ...tree,
        upstreams:
          tree.domain === undefined
            ? [{ prefix: "/api/" }, { prefix: "/auth/", url: "https://auth.example" }]
            : [{ prefix: "/cart/" }],
      })),
    };
    expect(() => vercel().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "vercel": 2 trees send prefixes to apps with no url, and this target proxies each prefix to the url its app answers at — set url on each to the https origin the deployed app answers at, such as "https://app.example":
  the default tree's prefix "/api/" (build.routing.upstreams)
  the "shop.example" tree's prefix "/cart/" (build.routing.upstreams)`,
      ),
    );
  });

  it("proxies each prefix to its app before the filesystem, and keeps the site's headers off it", () => {
    const notFound = {
      status: 404,
      dest: "/en/404",
      headers: { "X-Content-Type-Options": "nosniff" },
    };
    expect(JSON.parse(vercelJson(ROUTED))).toEqual({
      trailingSlash: false,
      cleanUrls: true,
      headers: [
        {
          source: "/:rest((?!a\\.b(?:/|$))(?!api(?:/|$)).*)",
          headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
        },
      ],
      routes: [
        { src: "^/manifest\\.json$", ...notFound },
        { src: "^/\\.pagedeck$", ...notFound },
        { src: "^/\\.pagedeck/.*$", ...notFound },
        { src: "^/a\\.b(/.*)?$", dest: "https://dots.example/a.b$1" },
        { src: "^/api(/.*)?$", dest: "https://app.example/api$1" },
        { handle: "filesystem" },
        { src: "^/.*$", ...notFound },
      ],
    });
  });

  it("gives no path under a prefix the site's headers, and every path beside one", () => {
    const { artifacts } = vercel().compile(ROUTED);
    const at = (path: string) => vercelHeadersAt(artifacts, undefined, path);
    for (const path of ["/api", "/api/", "/api/signup", "/a.b", "/a.b/x"]) {
      expect(at(path), path).toEqual([]);
    }
    for (const path of ["/", "/apix", "/apix/", "/axb/x", "/en/about"]) {
      expect(at(path), path).toEqual([NOSNIFF]);
    }
  });

  it("drops a header rule that only covers a prefix's paths", () => {
    const manifest = manifestOf({
      redirects: [],
      headers: [
        { prefix: "/api/v1/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
        { prefix: "/", set: [NOSNIFF] },
      ],
      upstreams: [{ prefix: "/api/", url: "https://app.example" }],
    });
    expect(JSON.parse(vercelJson(manifest)).headers).toEqual([
      {
        source: "/:rest((?!api(?:/|$)).*)",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ]);
  });

  it('refuses a prefix holding "$", which a route\'s dest reads as a capture', () => {
    const manifest = manifestOf({
      redirects: [],
      headers: [],
      upstreams: [{ prefix: "/a$b/", url: "https://app.example" }],
    });
    expect(() => vercel().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "vercel": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's upstream prefix "/a$b/" — Vercel reads "$" in a route's "dest" as the start of a capture reference, and offers no escape for a literal one`,
      ),
    );
  });

  it('refuses a prefix at or under "/.well-known/", which Vercel never rewrites', () => {
    const manifest = manifestOf({
      redirects: [],
      headers: [],
      upstreams: [
        { prefix: "/.well-known/", url: "https://app.example" },
        { prefix: "/.well-known/acme/", url: "https://acme.example" },
        { prefix: "/api/", url: "https://app.example" },
      ],
    });
    expect(() => vercel().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "vercel": 2 values cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's upstream prefix "/.well-known/" — Vercel answers /.well-known/ itself ("The /.well-known path is reserved and cannot be redirected or rewritten", https://vercel.com/docs/rewrites)
  the default tree's upstream prefix "/.well-known/acme/" — Vercel answers /.well-known/ itself ("The /.well-known path is reserved and cannot be redirected or rewritten", https://vercel.com/docs/rewrites)`,
      ),
    );
  });

  it("writes an empty upstream list as it writes none", () => {
    for (const tree of FIXTURE.trees) {
      const without = manifestOf(tree);
      expect(vercelJson({ ...without, trees: [{ ...tree, upstreams: [] }] })).toBe(
        vercelJson(without),
      );
    }
  });

  it("counts no upstream route against Vercel's redirect limit", () => {
    const redirects = Array.from({ length: 1024 }, (_, index) => ({
      from: `/r${String(index)}`,
      to: "/",
      status: 301 as const,
      source: "config" as const,
      via: [],
    }));
    const manifest = manifestOf({
      redirects,
      headers: [],
      upstreams: [
        { prefix: "/a.b/", url: "https://dots.example" },
        { prefix: "/api/", url: "https://app.example" },
      ],
    });
    const config = JSON.parse(vercelJson(manifest)) as {
      redirects: unknown[];
      routes: unknown[];
    };
    expect(config.redirects).toHaveLength(2048);
    expect(config.routes).toHaveLength(6);
  });
});
