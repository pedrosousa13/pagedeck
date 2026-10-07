import { describe, expect, it } from "vitest";

import { FIXTURE } from "./fixture.test-support.js";
import { resolveRequest } from "./oracle.test-support.js";

describe("resolveRequest", () => {
  it("answers an exact redirect with the first hop's status", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/en/legacy", found: false }),
    ).toEqual({
      kind: "redirect",
      to: "/en/about",
      status: 301,
      headers: [
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    });
  });

  it("does not answer a hop the chain flattened through", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/en/docs-v1", found: false }),
    ).toEqual({
      kind: "not-found",
      document: "/en/404",
      headers: [
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    });
  });

  it("gives a missing page the 404 page's set, not the set of the path requested", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/en/docs/gone", found: false }),
    ).toEqual({
      kind: "not-found",
      document: "/en/404",
      headers: [
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    });
  });

  it("makes no header claim on a bare 404, where the tree has no 404 page", () => {
    expect(
      resolveRequest(
        {
          ...FIXTURE,
          trees: [{ redirects: [], headers: FIXTURE.trees[0]?.headers ?? [] }],
        },
        { path: "/en/gone", found: false },
      ),
    ).toEqual({ kind: "not-found" });
  });

  it("gives a passing request the longest matching prefix's set alone", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/en/docs/intro", found: true }),
    ).toEqual({
      kind: "pass",
      headers: [{ name: "X-Frame-Options", value: "DENY" }],
    });
  });

  it("stops a prefix at the boundary its trailing slash draws", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/en/docsearch", found: true }),
    ).toEqual({
      kind: "pass",
      headers: [
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    });
  });

  it("passes a request no prefix matches with no headers", () => {
    expect(resolveRequest(FIXTURE, { path: "/de/index", found: true })).toEqual(
      {
        kind: "pass",
        headers: [],
      },
    );
  });

  it("resolves against the tree the request's host names", () => {
    expect(
      resolveRequest(FIXTURE, {
        domain: "shop.example",
        path: "/sale",
        found: false,
      }),
    ).toEqual({
      kind: "redirect",
      to: "/deals",
      status: 302,
      headers: [{ name: "X-Content-Type-Options", value: "nosniff" }],
    });
    expect(
      resolveRequest(FIXTURE, {
        domain: "shop.example",
        path: "/gone",
        found: false,
      }),
    ).toEqual({
      kind: "not-found",
      document: "/shop-404",
      headers: [{ name: "X-Content-Type-Options", value: "nosniff" }],
    });
  });
});
