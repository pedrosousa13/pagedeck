import { describe, expect, it } from "vitest";

import type { RoutingManifest } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { ALWAYS_FIXTURE } from "./fixture.test-support.js";
import { cloudflarePages } from "./index.js";

function defaultTree(): readonly EdgeArtifact[] {
  return cloudflarePages()
    .compile(ALWAYS_FIXTURE)
    .artifacts.filter((artifact) => artifact.domain === undefined);
}

function contentsOf(path: string): string {
  const artifact = defaultTree().find((candidate) => candidate.path === path);
  if (artifact === undefined) throw new Error(`no ${path} for cloudflare-pages`);
  return artifact.contents;
}

describe("cloudflare-pages", () => {
  it("proxies the reserved deploy keys to the 404 page, ahead of the redirect table", () => {
    expect(contentsOf("/_redirects")).toBe(`/manifest.json /en/404/ 200
/.pagedeck /en/404/ 200
/.pagedeck/* /en/404/ 200
/en/about /en/about/ 308
/en/docs/intro /en/docs/intro/ 308
/en/legacy /en/about/ 301
/en/legacy/ /en/about/ 301
/en/old-docs /en/docs/intro/ 308
/en/old-docs/ /en/docs/intro/ 308
`);
  });

  it("writes one block per prefix, least specific first, each detaching what it does not re-set", () => {
    expect(contentsOf("/_headers")).toBe(`/en/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/en/docs/*
  ! X-Content-Type-Options
  ! Referrer-Policy
  X-Frame-Options: DENY
`);
  });

  it("writes no fallback 404.html when the tree declares its own 404 page", () => {
    expect(defaultTree().find((artifact) => artifact.path === "/404.html")).toBeUndefined();
  });

  it("writes no _routes.json for a site that sends no prefix to an app", () => {
    expect(
      cloudflarePages()
        .compile(ALWAYS_FIXTURE)
        .artifacts.filter((artifact) => artifact.path === "/_routes.json"),
    ).toEqual([]);
  });

  it("includes each upstream prefix in its own tree's _routes.json, and changes nothing else", () => {
    const withUpstreams: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: ALWAYS_FIXTURE.trees.map((tree) =>
        tree.domain === undefined
          ? { ...tree, upstreams: ["/api/", "/auth/"] }
          : { ...tree, upstreams: ["/cart/"] },
      ),
    };
    const artifacts = cloudflarePages().compile(withUpstreams).artifacts;
    const routes = artifacts.filter((artifact) => artifact.path === "/_routes.json");

    expect(routes).toEqual([
      {
        role: "tree-file",
        path: "/_routes.json",
        contents: `{
  "version": 1,
  "include": [
    "/api/*",
    "/auth/*"
  ],
  "exclude": []
}
`,
      },
      {
        domain: "shop.example",
        role: "tree-file",
        path: "/_routes.json",
        contents: `{
  "version": 1,
  "include": [
    "/cart/*"
  ],
  "exclude": []
}
`,
      },
    ]);
    expect(artifacts.filter((artifact) => artifact.path !== "/_routes.json")).toEqual(
      cloudflarePages().compile(ALWAYS_FIXTURE).artifacts,
    );
  });
});
