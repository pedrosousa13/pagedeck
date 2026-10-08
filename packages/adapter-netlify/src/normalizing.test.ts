import { describe, expect, it } from "vitest";

import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import {
  ALWAYS_FILE,
  contentsOf,
  textOf,
} from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { netlify } from "./index.js";

describe("the claim the adapters are checked against", () => {
  it("leaves the root alone, which has one spelling under either policy", () => {
    const root: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [
        {
          redirects: [
            { from: "/old", to: "/", status: 301, source: "config", via: [] },
          ],
          headers: [],
        },
      ],
    };
    expect(textOf(netlify(), root)).toBe(
      "/manifest.json /.pagedeck/unserved 404!\n/.pagedeck /.pagedeck/unserved 404!\n/.pagedeck/* /.pagedeck/unserved 404!\n/old / 301\n/old/ / 301!\n",
    );
  });
});

describe("netlify's slash-insensitive matching", () => {
  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ : Netlify matches a
  // rule with or without a trailing slash, so a row between two spellings answers itself (#35).
  for (const manifest of [FIXTURE, ALWAYS_FILE]) {
    it(`writes no row between two spellings of one path under "${manifest.site.trailingSlash}"`, () => {
      const bare = (path: string) => path.replace(/(.)\/$/, "$1");
      const loops = contentsOf(netlify(), manifest, "/_redirects")
        .trimEnd()
        .split("\n")
        .map((line) => line.split(" "))
        .filter(([from = "", to = ""]) => bare(from) === bare(to));
      expect(loops).toEqual([]);
    });
  }
});
