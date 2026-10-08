import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import { planRouting } from "@pagedeck/core/routing";
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

  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ : "*" is a splat,
  // valid only at a path's end, and a ":"-led segment is a placeholder; neither has an escape.
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

  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ (#35)
  it("refuses a redirect that differs from its target only by a trailing slash", () => {
    const feed = planRouting({
      pages: [{ locale: "en", path: "/", output: "/", dependencies: [] }],
      trailingSlash: "always",
      emitted: [{ path: "/feed.xml" }],
      config: { redirects: [{ from: "/feed.xml/", to: "/feed.xml", status: 301 }] },
    });
    expect(() => netlify().compile(feed)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 redirect differs from its target only by a trailing slash — remove the redirect; this target matches a path with or without a trailing slash, so no rule can add or remove one:
  the default tree's redirect from "/feed.xml/" to "/feed.xml" — Netlify matches a rule with or without a trailing slash, so this rule would answer its own target with a redirect to itself`,
      ),
    );
  });

  it("compiles a document declaring no experiment on netlify", () => {
    expect(() => netlify().compile(FIXTURE)).not.toThrow();
  });
});

describe("paths off the site", () => {
  // Written by hand: `planRouting` refuses these, but a compiler is handed a document.
  const redirects = (
    rows: readonly (readonly [string, string])[],
  ): RoutingManifest["trees"][number]["redirects"] =>
    rows.map(([from, to]) => ({
      from,
      to,
      status: 301 as const,
      source: "config" as const,
      via: [],
    }));

  it("refuses a redirect target off the site on netlify, naming every one", () => {
    const offsite: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: redirects([
            ["/a/", "//evil.example/x\n/manifest.json /manifest.json 200!"],
            ["/b/", "https://evil.example/"],
            ["/c/", "/pricing/"],
          ]),
          headers: [],
        },
      ],
    };
    expect(() => netlify().compile(offsite)).toThrow(
      new ConfigError(
        `Edge target "netlify": 2 redirect targets are not paths on this site — write a tree-relative path like "/pricing"; a target off this site compiles to an open redirect at the edge:
  the default tree's redirect target on "/a/" — the target begins "//", which is a host
  the default tree's redirect target on "/b/" — the target holds a scheme`,
      ),
    );
  });

  it("refuses a redirect source off the site on netlify, naming every one", () => {
    const offsite: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: redirects([
            ["/a\n/manifest.json/", "/pricing/"],
            ["https://evil.example/b/", "/pricing/"],
          ]),
          headers: [],
        },
      ],
    };
    expect(() => netlify().compile(offsite)).toThrow(
      new ConfigError(
        `Edge target "netlify": 2 redirect sources are not paths on this site — write a tree-relative path like "/pricing"; the edge matches the path alone, so a source spelled as a URL is a rule that can never fire:
  the default tree's redirect from "/a\\n/manifest.json/" — the source holds a control character
  the default tree's redirect from "https://evil.example/b/" — the source holds a scheme`,
      ),
    );
  });

  it("refuses a \":\" anywhere in a path on netlify", () => {
    const colon: RoutingManifest = {
      ...FIXTURE,
      trees: [
        { redirects: redirects([["/time-12:30/", "/pricing/"]]), headers: [] },
      ],
    };
    expect(() => netlify().compile(colon)).toThrow(
      new ConfigError(
        `Edge target "netlify": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/time-12:30/" — Netlify reads ":" in a path pattern as the start of a placeholder, and offers no escape for a literal one`,
      ),
    );
  });

  it("refuses whitespace in every path it writes on netlify", () => {
    const spaced: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: redirects([
            ["/a b/", "/pricing/"],
            ["/c/", "/x\u00A0y/"],
          ]),
          notFound: "/not\tfound/",
          headers: [{ prefix: "/p q/", set: [{ name: "X-Note", value: "v" }] }],
        },
      ],
    };
    expect(() => netlify().compile(spaced)).toThrow(
      new ConfigError(
        `Edge target "netlify": 4 values cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/a b/" — Netlify reads U+0020, a whitespace character, as the end of a path pattern, and offers no escape for a literal one
  the default tree's redirect target on "/c/" — Netlify reads U+00A0, a whitespace character, as the end of a path pattern, and offers no escape for a literal one
  the default tree's 404 page — Netlify reads U+0009, a whitespace character, as the end of a path pattern, and offers no escape for a literal one
  the default tree's header prefix "/p q/" — Netlify reads U+0020, a whitespace character, as the end of a path pattern, and offers no escape for a literal one`,
      ),
    );
  });
});
