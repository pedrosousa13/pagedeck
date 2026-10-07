import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { ResolvedRedirect, RoutingManifest } from "@pagedeck/core/routing";

import { HEADER_NAME_FIX } from "../../edge/src/conformance.test-support.js";
import { ALWAYS_FIXTURE } from "./fixture.test-support.js";
import { cloudflarePages } from "./index.js";

describe("trailing slashes", () => {
  it('refuses trailingSlash: "never"', () => {
    const manifest: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [{ redirects: [], headers: [] }],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 tree cannot serve the site's trailingSlash policy — set trailingSlash: "always":\n  the default tree — site.trailingSlash is "never", and Cloudflare Pages redirects a directory's index.html to its slashed address on its own`,
      ),
    );
  });

  it("reports the policy fault only once across multiple trees", () => {
    const manifest: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [
        { redirects: [], headers: [] },
        { domain: "shop.example", redirects: [], headers: [] },
      ],
    };
    try {
      cloudflarePages().compile(manifest);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message.match(/site\.trailingSlash is "never"/g)).toHaveLength(1);
    }
  });

  it('compiles a document declaring "always"', () => {
    expect(() => cloudflarePages().compile(ALWAYS_FIXTURE)).not.toThrow();
  });
});

describe("compile refusals", () => {
  it('refuses a path Cloudflare Pages would read as a splat', () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: "/a*b/",
              to: "/pricing/",
              status: 301,
              source: "config",
              via: [],
            },
          ],
          headers: [],
        },
      ],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:\n  the default tree's redirect from "/a*b/" — Cloudflare Pages reads "*" in a path pattern as a splat, and offers no escape for a literal one`,
      ),
    );
  });

  it('refuses the header name "/evil/*" as not a token', () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [{ prefix: "/", set: [{ name: "/evil/*", value: "x" }] }],
        },
      ],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 header name is not a token — ${HEADER_NAME_FIX}:\n  the default tree's header name "/evil/*" under prefix "/" — the header name holds "/", and a header name is one RFC 9110 token`,
      ),
    );
  });

  it("refuses a declared experiment", () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [],
          experiments: [
            {
              path: "/en/pricing/",
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
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 tree declares an experiment this target cannot compile — drop the experiment, or compile cloudfront-function, the only target that compiles a split:\n  the default tree's experiment on "/en/pricing/" (build.routing.experiments)`,
      ),
    );
  });

  it("refuses a nested header rule that sets the same name as an enclosing one", () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [
            { prefix: "/en/docs/", set: [{ name: "X-Frame-Options", value: "SAMEORIGIN" }] },
            { prefix: "/en/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
          ],
        },
      ],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:\n  the default tree's header "X-Frame-Options" under prefix "/en/docs/" — also set under the enclosing prefix "/en/", and Cloudflare Pages joins a header set twice with a comma rather than letting a nested rule replace it`,
      ),
    );
  });

  it("compiles the same name set at two prefixes that do not nest", () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [
            { prefix: "/en/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
            { prefix: "/de/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
          ],
        },
      ],
    };
    expect(() => cloudflarePages().compile(manifest)).not.toThrow();
  });

  it("refuses more redirects than Cloudflare Pages' per-file limit", () => {
    const redirects: ResolvedRedirect[] = [];
    for (let index = 0; index < 1000; index += 1) {
      redirects.push({
        from: `/p${String(index)}/`,
        to: `/t${String(index)}`,
        file: true,
        status: 301,
        source: "config",
        via: [],
      });
    }
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [{ redirects, headers: [] }],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 artifact exceeds its size limit — reduce the rule set, or raise the limit if the host's is higher:\n  the default tree's _redirects — 2003 redirects, limit 2000`,
      ),
    );
  });

  it("refuses more header rules than Cloudflare Pages' per-file limit", () => {
    const headers = [];
    for (let index = 0; index < 101; index += 1) {
      headers.push({ prefix: `/p${String(index)}/`, set: [{ name: "X-Frame-Options", value: "DENY" }] });
    }
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [{ redirects: [], headers }],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-pages": 1 artifact exceeds its size limit — reduce the rule set, or raise the limit if the host's is higher:\n  the default tree's _headers — 101 header rules, limit 100`,
      ),
    );
  });

  it("refuses a redirect line over Cloudflare Pages' character limit", () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [
            {
              from: `/${"p".repeat(1000)}/`,
              to: "/pricing/",
              status: 301,
              source: "config",
              via: [],
            },
          ],
          headers: [],
        },
      ],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(/characters, limit 1000/);
  });

  it("refuses a header line over Cloudflare Pages' character limit", () => {
    const manifest: RoutingManifest = {
      ...ALWAYS_FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [{ prefix: "/", set: [{ name: "X-Note", value: "v".repeat(2000) }] }],
        },
      ],
    };
    expect(() => cloudflarePages().compile(manifest)).toThrow(/characters, limit 2000/);
  });
});
