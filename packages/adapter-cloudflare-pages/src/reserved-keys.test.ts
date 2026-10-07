import { describe, expect, it } from "vitest";

import { ALWAYS_FIXTURE, BARE } from "./fixture.test-support.js";
import { cloudflarePages } from "./index.js";
import { interpretCloudflarePages } from "./interpret.test-support.js";

describe("a tree with a 404 page", () => {
  const artifacts = cloudflarePages().compile(ALWAYS_FIXTURE).artifacts;

  it("proxies a reserved deploy key to the 404 page rather than serving its own bytes", () => {
    expect(
      interpretCloudflarePages(artifacts, { path: "/manifest.json", found: true }),
    ).toEqual({ kind: "not-found", document: "/en/404/", headers: [] });
    expect(
      interpretCloudflarePages(artifacts, {
        path: "/.pagedeck/manifests/0b6e4f53-3f0c-4a5e-9d0f-6f7f1d2a9c11.json",
        found: true,
      }),
    ).toEqual({ kind: "not-found", document: "/en/404/", headers: [] });
  });

  it("carries the headers of the second tree's own root rule, since it covers every path there", () => {
    expect(
      interpretCloudflarePages(artifacts, {
        domain: "shop.example",
        path: "/manifest.json",
        found: true,
      }),
    ).toEqual({
      kind: "not-found",
      document: "/shop-404/",
      headers: [{ name: "X-Content-Type-Options", value: "nosniff" }],
    });
  });

  it("writes no fallback 404.html artifact", () => {
    expect(artifacts.find((artifact) => artifact.path === "/404.html")).toBeUndefined();
  });
});

describe("a tree with no 404 page", () => {
  const artifacts = cloudflarePages().compile(BARE).artifacts;

  it("writes its own minimal fallback at the tree's root", () => {
    const fallback = artifacts.find((artifact) => artifact.path === "/404.html");
    expect(fallback?.role).toBe("tree-file");
    expect(fallback?.contents).toContain("Not Found");
  });

  it("still denies a reserved deploy key, as a bare not-found", () => {
    expect(
      interpretCloudflarePages(artifacts, { path: "/manifest.json", found: true }),
    ).toEqual({ kind: "not-found" });
    expect(
      interpretCloudflarePages(artifacts, { path: "/.pagedeck", found: true }),
    ).toEqual({ kind: "not-found" });
    expect(
      interpretCloudflarePages(artifacts, {
        path: "/.pagedeck/manifests/0b6e4f53-3f0c-4a5e-9d0f-6f7f1d2a9c11.deployed-at",
        found: true,
      }),
    ).toEqual({ kind: "not-found" });
  });

  it("still gets its headers on a real page", () => {
    expect(
      interpretCloudflarePages(artifacts, { path: "/about/", found: true }),
    ).toEqual({
      kind: "pass",
      headers: [{ name: "X-Content-Type-Options", value: "nosniff" }],
    });
  });
});
