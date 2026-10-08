import { describe, expect, it } from "vitest";

import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { contentsOf } from "../../edge/src/conformance.test-support.js";
import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import { vercel } from "./index.js";
import { interpretVercel } from "./interpret.test-support.js";

function nestedUnderRoot(nested: string): RoutingManifest {
  return {
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      {
        redirects: [],
        headers: [
          { prefix: nested, set: [{ name: "X-Frame-Options", value: "DENY" }] },
          { prefix: "/", set: [{ name: "X-Content-Type-Options", value: "nosniff" }] },
        ],
      },
    ],
  };
}

// A nested prefix's text is a regex inside the lookahead path-to-regexp keeps (#37).
describe.each([
  { nested: "/v1.0/", source: "/:rest((?!v1\\.0/).*)", paths: ["/v1.0/page", "/v1x0/page"] },
  { nested: "/a$b/", source: "/:rest((?!a\\$b/).*)", paths: ["/a$b/page", "/ab/page"] },
])("a regex metacharacter in the nested prefix $nested", ({ nested, source, paths }) => {
  const manifest = nestedUnderRoot(nested);
  const artifacts = vercel().compile(manifest).artifacts;

  it("is escaped in the enclosing rule's lookahead", () => {
    const rules = (
      JSON.parse(contentsOf(vercel(), manifest, "/vercel.json")) as {
        headers: { source: string }[];
      }
    ).headers;
    expect(rules.map((rule) => rule.source)).toEqual([`${nested}:rest(.*)`, source]);
  });

  it.each(paths)("leaves %s exactly one rule's headers", (path) => {
    const request = { path, found: true };
    expect(comparable(interpretVercel(artifacts, request))).toEqual(
      comparable(resolveRequest(manifest, request)),
    );
  });
});
