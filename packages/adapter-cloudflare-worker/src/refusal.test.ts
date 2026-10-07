import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import {
  HEADER_NAME_FIX,
  HEADER_VALUE_FIX,
} from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { cloudflareWorker } from "./index.js";

describe("compile refusals", () => {
  it("names every unusable header field in every tree, in one report", () => {
    const broken: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [
            {
              prefix: "/",
              set: [
                { name: "X A", value: "v" },
                { name: "X-B", value: "v\r\nSet-Cookie: a=b" },
              ],
            },
          ],
        },
        {
          domain: "shop.example",
          redirects: [],
          headers: [
            {
              prefix: "/en/",
              set: [
                { name: "", value: "v" },
                { name: "X-C", value: "\u0000" },
              ],
            },
          ],
        },
      ],
    };
    expect(() =>
      cloudflareWorker().compile(broken),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 2 header names are not tokens — ${HEADER_NAME_FIX}:
  the default tree's header name "X A" under prefix "/" — the header name holds " ", and a header name is one RFC 9110 token
  the "shop.example" tree's header name "" under prefix "/en/" — the header name is empty

Edge target "cloudflare-worker": 2 header values cannot be sent — ${HEADER_VALUE_FIX}:
  the default tree's header "X-B" under prefix "/" — the header value holds U+000D
  the "shop.example" tree's header "X-C" under prefix "/en/" — the header value holds U+0000`,
      ),
    );
  });

  it("refuses a declared experiment on cloudflare-worker", () => {
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
    expect(() => cloudflareWorker().compile(split)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 1 tree declares an experiment this target cannot compile — drop the experiment, or compile cloudfront-function, the only target that compiles a split:
  the default tree's experiment on "/en/pricing" (build.routing.experiments)`,
      ),
    );
  });

  it("compiles a document declaring no experiment on cloudflare-worker", () => {
    expect(() => cloudflareWorker().compile(FIXTURE)).not.toThrow();
  });

  it("refuses a redirect target off the site on cloudflare-worker, naming every one", () => {
    // Written by hand: `planRouting` refuses these, but a compiler is handed a document.
    const offsite: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: (
            [
              ["/a", "https://evil.example/"],
              ["/b", "//evil.example/"],
              ["/c", "/\\evil.example/"],
              ["/d", "/pricing"],
            ] as const
          ).map(([from, to]) => ({
            from,
            to,
            status: 301 as const,
            source: "config" as const,
            via: [],
          })),
          headers: [],
        },
      ],
    };
    expect(() =>
      cloudflareWorker().compile(offsite),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 3 redirect targets are not paths on this site — write a tree-relative path like "/pricing"; a target off this site compiles to an open redirect at the edge:
  the default tree's redirect target on "/a" — the target holds a scheme
  the default tree's redirect target on "/b" — the target begins "//", which is a host
  the default tree's redirect target on "/c" — the target holds a backslash`,
      ),
    );
  });
});
