import { describe, expect, it } from "vitest";

import type { RoutingManifest } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { netlify } from "./index.js";

function defaultTree(): readonly EdgeArtifact[] {
  return netlify().compile(FIXTURE).artifacts.filter(
    (artifact) => artifact.domain === undefined,
  );
}

function contentsOf(path: string): string {
  const artifact = defaultTree().find((candidate) => candidate.path === path);
  if (artifact === undefined) throw new Error(`no ${path} for netlify`);
  return artifact.contents;
}

describe("netlify", () => {
  it("emits the redirect table with the 404 catch-all last", () => {
    expect(contentsOf("/_redirects")).toBe(`/manifest.json /en/404 404!
/.pagedeck /en/404 404!
/.pagedeck/* /en/404 404!
/en/about/ /en/about 301!
/en/docs/intro/ /en/docs/intro 301!
/en/legacy /en/about 301
/en/legacy/ /en/about 301!
/en/old-docs /en/docs/intro 301
/en/old-docs/ /en/docs/intro 301!
/* /en/404 404
`);
  });

  it("maps 308 and 307 to the status Netlify documents (#10)", () => {
    // https://docs.netlify.com/manage/routing/redirects/redirect-options/ documents only
    // 301, 302, 200 and 404 for a redirect, names 307 "currently unsupported", and does not
    // name 308 at all: mapped rather than refused, to the status of the same permanence.
    const manifest: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: "/old-permanent",
              to: "/new",
              status: 308,
              source: "config",
              via: [],
            },
            {
              from: "/old-temporary",
              to: "/new",
              status: 307,
              source: "config",
              via: [],
            },
          ],
          headers: [],
        },
      ],
    };
    const file = netlify()
      .compile(manifest)
      .artifacts.find((artifact) => artifact.path === "/_redirects");
    expect(file?.contents).toContain("/old-permanent /new 301");
    expect(file?.contents).toContain("/old-temporary /new 302");
  });

  it("emits one block per prefix, longest first, each set complete", () => {
    expect(contentsOf("/_headers")).toBe(`/en/docs/*
  X-Frame-Options: DENY

/en/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`);
  });
});
