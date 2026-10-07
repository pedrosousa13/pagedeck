import { describe, expect, it } from "vitest";

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
/en/about/ /en/about 308!
/en/docs/intro/ /en/docs/intro 308!
/en/legacy /en/about 301
/en/legacy/ /en/about 301!
/en/old-docs /en/docs/intro 308
/en/old-docs/ /en/docs/intro 308!
/* /en/404 404
`);
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
