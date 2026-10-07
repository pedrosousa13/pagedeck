import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { nginx } from "./index.js";

describe("compile refusals", () => {
  it("names every value a target's grammar cannot hold, in one report", () => {
    const dollars: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: "/price$",
              to: "/pricing",
              status: 301,
              source: "config",
              via: [],
            },
          ],
          headers: [
            {
              prefix: "/en/",
              set: [
                { name: "Content-Security-Policy", value: "img-src $self" },
              ],
            },
          ],
        },
      ],
    };
    expect(() => nginx().compile(dollars)).toThrow(
      new ConfigError(
        `Edge target "nginx": 2 values cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/price$" — nginx interpolates "$" inside a quoted string, and offers no escape for a literal one
  the default tree's header "Content-Security-Policy" under prefix "/en/" — nginx interpolates "$" inside a quoted string, and offers no escape for a literal one`,
      ),
    );
  });

  it("names a header field name nginx would read as a variable", () => {
    const named: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [
            {
              prefix: "/",
              set: [{ name: "X-$request_uri", value: "v" }],
            },
          ],
        },
      ],
    };
    expect(() => nginx().compile(named)).toThrow(
      new ConfigError(
        `Edge target "nginx": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's header name "X-$request_uri" under prefix "/" — nginx interpolates "$" inside a quoted string, and offers no escape for a literal one`,
      ),
    );
  });

  it("refuses a declared experiment on nginx", () => {
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
    expect(() => nginx().compile(split)).toThrow(
      new ConfigError(
        `Edge target "nginx": 1 tree declares an experiment this target cannot compile — drop the experiment, or compile cloudfront-function, the only target that compiles a split:
  the default tree's experiment on "/en/pricing" (build.routing.experiments)`,
      ),
    );
  });

  it("compiles a document declaring no experiment on nginx", () => {
    expect(() => nginx().compile(FIXTURE)).not.toThrow();
  });
});
