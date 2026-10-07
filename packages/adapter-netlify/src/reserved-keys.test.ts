import { describe, expect, it } from "vitest";

import { contentsOf } from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { netlify } from "./index.js";

describe("the emitted rule", () => {
  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ documents `!` forcing
  // a redirect past a file the origin holds, which is what these reserved rows rely on.
  it("is the first rows of _redirects, forced past the files the origin holds", () => {
    expect(contentsOf(netlify(), FIXTURE, "/_redirects")).toMatch(
      /^\/manifest\.json \/en\/404 404!\n\/\.pagedeck \/en\/404 404!\n\/\.pagedeck\/\* \/en\/404 404!\n/,
    );
  });
});
