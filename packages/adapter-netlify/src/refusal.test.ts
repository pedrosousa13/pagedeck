import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { HEADER_NAME_FIX } from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { netlify } from "./index.js";

describe("compile refusals", () => {
  it('refuses the header name "/evil/*" on netlify as not a token', () => {
    // Written by hand: `planRouting` can no longer produce it, but a compiler is handed a document.
    const block: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [
            {
              prefix: "/",
              set: [{ name: "/evil/*", value: "x" }],
            },
          ],
        },
      ],
    };
    expect(() => netlify().compile(block)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "/evil/*" under prefix "/" — the header name holds "/", and a header name is one RFC 9110 token`,
      ),
    );
  });

  it("refuses a path Netlify would read as a splat", () => {
    const splat: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: "/a*b",
              to: "/pricing",
              status: 301,
              source: "config",
              via: [],
            },
          ],
          headers: [],
        },
      ],
    };
    expect(() => netlify().compile(splat)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/a*b" — Netlify reads "*" in a path pattern as a splat, and offers no escape for a literal one`,
      ),
    );
  });

  it("refuses a redirect status Netlify does not serve", () => {
    // https://docs.netlify.com/manage/routing/redirects/redirect-options/ documents only
    // 200, 301, 302 and 404 for a redirect, and names 307 directly: "Use this status code
    // [302] instead of 307, which is currently unsupported."
    const unserved: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: "/old",
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
    expect(() => netlify().compile(unserved)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 redirect declares a status this target does not serve — use a status this target serves, such as 301 or 302:
  the default tree's redirect from "/old" — status 307, and Netlify documents only 301, 302, 200 and 404 for a redirect`,
      ),
    );
  });

  it("refuses a declared experiment on netlify", () => {
    const split: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [],
          experiments: [
            {
              path: "/en/pricing",
              cookie: "fw_pricing",
              variants: [
                { name: "a", weight: 1 },
                { name: "b", weight: 3 },
              ],
            },
          ],
        },
      ],
    };
    expect(() => netlify().compile(split)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 tree declares an experiment this target cannot compile — drop the experiment, or compile cloudfront-function, the only target that compiles a split:
  the default tree's experiment on "/en/pricing" (build.routing.experiments)`,
      ),
    );
  });

  it("compiles a document declaring no experiment on netlify", () => {
    expect(() => netlify().compile(FIXTURE)).not.toThrow();
  });
});
