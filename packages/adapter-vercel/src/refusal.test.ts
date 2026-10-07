import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { HEADER_NAME_FIX } from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { vercel } from "./index.js";

describe("compile refusals", () => {
  it('refuses the header name "/evil/*" on vercel as not a token', () => {
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
    expect(() => vercel().compile(block)).toThrow(
      new ConfigError(
        `Edge target "vercel": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "/evil/*" under prefix "/" — the header name holds "/", and a header name is one RFC 9110 token`,
      ),
    );
  });

  it("refuses a redirect source Vercel would read as path-to-regexp syntax", () => {
    const special: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: "/a:b",
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
    expect(() => vercel().compile(special)).toThrow(
      new ConfigError(
        `Edge target "vercel": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/a:b" — Vercel reads ":" in a path pattern as path-to-regexp syntax, and offers no escape for a literal one`,
      ),
    );
  });

  it("refuses a declared experiment on vercel", () => {
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
    expect(() => vercel().compile(split)).toThrow(
      new ConfigError(
        `Edge target "vercel": 1 tree declares an experiment this target cannot compile — drop the experiment, or compile cloudfront-function, the only target that compiles a split:
  the default tree's experiment on "/en/pricing" (build.routing.experiments)`,
      ),
    );
  });

  it("refuses more redirects than Vercel documents a limit for", () => {
    // 1025 authored rows, each a file target so `compiledTree` adds one derived row and no
    // more: 2050 compiled rows, just past the limit.
    const many: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [
        {
          redirects: Array.from({ length: 1025 }, (_, index) => ({
            from: `/old-${String(index)}`,
            to: "/new",
            status: 301 as const,
            source: "config" as const,
            via: [],
            file: true as const,
          })),
          headers: [],
        },
      ],
    };
    expect(() => vercel().compile(many)).toThrow(
      new ConfigError(
        `Edge target "vercel": 1 value exceeds a limit this target documents — reduce the rule set, or compile a target whose documented limit is higher:
  the default tree declares 2050 redirects, Vercel's documented limit is 2048 (https://vercel.com/docs/routing/redirects/configuration-redirects#limits)`,
      ),
    );
  });

  it("refuses a redirect address longer than Vercel documents a limit for", () => {
    const long: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: `/${"a".repeat(4096)}`,
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
    expect(() => vercel().compile(long)).toThrow(ConfigError);
    expect(() => vercel().compile(long)).toThrow(
      /Vercel's documented limit for "source" and "destination" is 4096/,
    );
  });

  it("compiles a document declaring no experiment on vercel", () => {
    expect(() => vercel().compile(FIXTURE)).not.toThrow();
  });
});
