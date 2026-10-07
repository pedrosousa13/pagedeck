import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { compileRouting, EDGE_TARGETS } from "./index.js";
import { FIXTURE } from "./fixture.test-support.js";

const HEADER_NAME_FIX =
  'write the name as a header field name, such as "X-Frame-Options"; a name that is not one is emitted verbatim, and each target then either reads that line as a different field than the one written, or refuses it outright after the build has already reported success';
const HEADER_VALUE_FIX =
  "remove the character; RFC 9110 forbids CR, LF and NUL in a field value, where a line break can write a second header, and a Worker's Headers refuses any character above U+00FF";

describe("compileRouting refusals", () => {
  it("names every supported target when it does not know one", () => {
    expect(() => compileRouting(FIXTURE, { target: "fastly" })).toThrow(
      new ConfigError(
        'Edge target "fastly" is not supported — use one of: cloudfront-function, netlify, nginx, cloudflare-worker',
      ),
    );
  });

  it("classifies an unknown target as wiring, exit 2", () => {
    expect(() => compileRouting(FIXTURE, { target: "fastly" })).toThrow(
      ConfigError,
    );
  });

  it("refuses a routing document written by a newer core", () => {
    const newer: RoutingManifest = { ...FIXTURE, version: 2 };
    expect(() => compileRouting(newer, { target: "nginx" })).toThrow(
      new ConfigError(
        "Routing manifest: version 2 is newer than this compiler reads (1) — upgrade @pagedeck/edge, or build with the @pagedeck/core that wrote it",
      ),
    );
  });

  it("refuses a routing document written by an older core", () => {
    const older: RoutingManifest = { ...FIXTURE, version: 0 };
    expect(() => compileRouting(older, { target: "nginx" })).toThrow(
      new ConfigError(
        "Routing manifest: version 0 is older than this compiler reads (1) — upgrade the @pagedeck/core that wrote it, or downgrade @pagedeck/edge",
      ),
    );
  });

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
    expect(() => compileRouting(dollars, { target: "nginx" })).toThrow(
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
    expect(() => compileRouting(named, { target: "nginx" })).toThrow(
      new ConfigError(
        `Edge target "nginx": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's header name "X-$request_uri" under prefix "/" — nginx interpolates "$" inside a quoted string, and offers no escape for a literal one`,
      ),
    );
  });

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
    expect(() => compileRouting(block, { target: "netlify" })).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "/evil/*" under prefix "/" — the header name holds "/", and a header name is one RFC 9110 token`,
      ),
    );
  });

  function withHeader(name: string, value: string): RoutingManifest {
    // Written by hand: `planRouting` refuses most of these, but a compiler is handed a document.
    return {
      ...FIXTURE,
      trees: [
        { redirects: [], headers: [{ prefix: "/", set: [{ name, value }] }] },
      ],
    };
  }

  for (const target of EDGE_TARGETS) {
    it(`refuses a header name holding a space on ${target}`, () => {
      expect(() =>
        compileRouting(withHeader("X-Frame Options", "DENY"), { target }),
      ).toThrow(
        new ConfigError(
          `Edge target "${target}": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "X-Frame Options" under prefix "/" — the header name holds " ", and a header name is one RFC 9110 token`,
        ),
      );
    });

    for (const [what, character, named] of [
      ["CR", "\r", "U+000D"],
      ["LF", "\n", "U+000A"],
      ["NUL", "\u0000", "U+0000"],
      ["U+0100", "\u0100", "U+0100"],
      ["an emoji", "\u{1F600}", "U+1F600"],
    ] as const) {
      it(`refuses a header value holding ${what} on ${target}, never quoting the value`, () => {
        expect(() =>
          compileRouting(withHeader("X-Note", `a${character}b`), { target }),
        ).toThrow(
          new ConfigError(
            `Edge target "${target}": 1 header value cannot be sent — ${HEADER_VALUE_FIX}:
  the default tree's header "X-Note" under prefix "/" — the header value holds ${named}`,
          ),
        );
      });
    }

    it(`compiles a header value holding "é", below U+0100, on ${target}`, () => {
      expect(() =>
        compileRouting(withHeader("X-Note", "café"), { target }),
      ).not.toThrow();
    });
  }

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
      compileRouting(broken, { target: "cloudflare-worker" }),
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
    expect(() => compileRouting(splat, { target: "netlify" })).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/a*b" — Netlify reads "*" in a path pattern as a splat, and offers no escape for a literal one`,
      ),
    );
  });

  for (const target of ["netlify", "nginx", "cloudflare-worker"] as const) {
    it(`refuses a declared experiment on ${target}`, () => {
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
      expect(() => compileRouting(split, { target })).toThrow(
        new ConfigError(
          `Edge target "${target}": 1 tree declares an experiment this target cannot compile — drop the experiment, or compile cloudfront-function, the only target that compiles a split:
  the default tree's experiment on "/en/pricing" (build.routing.experiments)`,
        ),
      );
    });

    it(`compiles a document declaring no experiment on ${target}`, () => {
      expect(() => compileRouting(FIXTURE, { target })).not.toThrow();
    });
  }

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
      compileRouting(offsite, { target: "cloudflare-worker" }),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 3 redirect targets are not paths on this site — write a tree-relative path like "/pricing"; a target off this site compiles to an open redirect at the edge:
  the default tree's redirect target on "/a" — the target holds a scheme
  the default tree's redirect target on "/b" — the target begins "//", which is a host
  the default tree's redirect target on "/c" — the target holds a backslash`,
      ),
    );
  });

  it("names the artifact, its size and its limit when one overflows", () => {
    // Reachable only by forcing the limit: the dataset form is O(1) in rule count.
    expect(() =>
      compileRouting(FIXTURE, {
        target: "cloudfront-function",
        limits: { function: 64 },
      }),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudfront-function": 4 artifacts exceed their size limit — reduce the rule set, or raise the limit if the host's is higher:
  the default tree's viewer-request function — 2040 bytes, limit 64
  the default tree's viewer-response function — 1022 bytes, limit 64
  the "shop.example" tree's viewer-request function — 1895 bytes, limit 64
  the "shop.example" tree's viewer-response function — 879 bytes, limit 64`,
      ),
    );
  });
});
