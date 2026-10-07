import { describe, expect, it } from "vitest";

import { EN_HEADERS, ID } from "./conformance.test-support.js";
import { FIXTURE } from "./fixture.test-support.js";
import { resolveRequest } from "./oracle.test-support.js";

describe("the oracle", () => {
  it("claims the site's 404 for a reserved deploy key the origin holds", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/manifest.json", found: true }),
    ).toEqual({ kind: "not-found", document: "/en/404", headers: EN_HEADERS });
    expect(
      resolveRequest(FIXTURE, {
        domain: "shop.example",
        path: `/.pagedeck/manifests/${ID}.deployed-at`,
        found: true,
      }),
    ).toEqual({
      kind: "not-found",
      document: "/shop-404",
      headers: [{ name: "X-Content-Type-Options", value: "nosniff" }],
    });
  });

  it("does not claim a path that only begins like the history's directory", () => {
    expect(resolveRequest(FIXTURE, { path: "/.fwd", found: true })).toEqual({
      kind: "pass",
      headers: [],
    });
  });
});
