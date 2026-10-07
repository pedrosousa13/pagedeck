import { describe, expect, it } from "vitest";

import {
  ALWAYS_FILE,
  FILE,
  NEVER,
  SLASHED_FILE,
} from "./conformance.test-support.js";
import { compiledTree } from "./normalize.js";
import { resolveRequest } from "./oracle.test-support.js";

describe("the claim the adapters are checked against", () => {
  it("sends a redirect source's other spelling where the source goes", () => {
    expect(resolveRequest(NEVER, { path: "/en/legacy/", found: true })).toEqual(
      { kind: "redirect", to: "/en/about", status: 301, headers: [] },
    );
  });

  it("sends a page's other spelling to the page, permanently", () => {
    expect(resolveRequest(NEVER, { path: "/en/about/", found: true })).toEqual({
      kind: "redirect",
      to: "/en/about",
      status: 308,
      headers: [],
    });
  });
});

describe("a file target has no other spelling", () => {
  it("the claim answers the slashed file with a 404", () => {
    expect(resolveRequest(FILE, SLASHED_FILE)).toEqual({ kind: "not-found" });
    expect(
      resolveRequest(FILE, { path: "/sitemap-index.xml/", found: false }),
    ).toEqual({ kind: "redirect", to: "/sitemap.xml", status: 301, headers: [] });
  });
});

describe("under trailingSlash always, a file target is not redirected to itself", () => {
  const tree = ALWAYS_FILE.trees[0];
  if (tree === undefined) throw new Error("expected one tree");
  const compiled = compiledTree(tree, "always").redirects;

  it("the document spells the target as the file and marks it", () => {
    expect(tree.redirects).toContainEqual(
      expect.objectContaining({
        from: "/sitemap-index.xml/",
        to: "/sitemap.xml",
        file: true,
      }),
    );
  });

  it("the compiled tree holds no rule onto its own source and none from the file", () => {
    expect(compiled.filter((rule) => rule.from === rule.to)).toEqual([]);
    expect(compiled.filter((rule) => rule.from === "/sitemap.xml")).toEqual([]);
  });
});
