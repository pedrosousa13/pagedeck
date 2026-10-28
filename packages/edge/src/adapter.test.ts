import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { defineAdapter } from "./adapter.js";
import type { AdapterDefinition } from "./adapter.js";
import { FIXTURE } from "./fixture.test-support.js";

// A host the base has never heard of: the contract is what is under test, not a grammar.
const stub = defineAdapter({
  name: "stub",
  limits: { "tree-file": 16 },
  compileTree: (tree, faults) => {
    if (tree.domain !== undefined) {
      faults.push({ kind: "unexpressible", line: `tree "${tree.domain}"` });
    }
    return [{ role: "tree-file", path: "/stub", contents: "x".repeat(17) }];
  },
});

describe("defineAdapter", () => {
  it("names the adapter in its output", () => {
    expect(stub.compile({ ...FIXTURE, trees: [] })).toEqual({
      target: "stub",
      artifacts: [],
    });
  });

  it("refuses a routing document written by a newer core", () => {
    const newer: RoutingManifest = { ...FIXTURE, version: 2 };
    expect(() => stub.compile(newer)).toThrow(
      new ConfigError(
        'Routing manifest: version 2 is newer than edge adapter "stub" reads (1) — upgrade the @pagedeck/adapter-* package you compile with, or build with the @pagedeck/core that wrote it',
      ),
    );
  });

  it("refuses a routing document written by an older core", () => {
    const older: RoutingManifest = { ...FIXTURE, version: 0 };
    expect(() => stub.compile(older)).toThrow(
      new ConfigError(
        'Routing manifest: version 0 is older than edge adapter "stub" reads (1) — upgrade the @pagedeck/core that wrote it, or downgrade the @pagedeck/adapter-* package you compile with',
      ),
    );
  });

  it("reports every tree's faults and every oversized artifact in one refusal, cause first", () => {
    expect(() => stub.compile(FIXTURE)).toThrow(
      new ConfigError(
        `Edge target "stub": 1 value cannot be expressed by this target — change each value as its line says, or compile a target that can express it:
  tree "shop.example"

Edge target "stub": 2 artifacts exceed their size limit — reduce the rule set, or raise the limit if the host's is higher:
  the default tree's "/stub" — 17 bytes, limit 16
  the default tree's "/stub" — 17 bytes, limit 16`,
      ),
    );
  });

  describe("a tree that sends a prefix to an app", () => {
    const routed: RoutingManifest = {
      ...FIXTURE,
      trees: [{ redirects: [], headers: [], upstreams: [{ prefix: "/api/" }] }],
    };
    const proxied: RoutingManifest = {
      ...FIXTURE,
      trees: [
        {
          redirects: [],
          headers: [],
          upstreams: [{ prefix: "/api/", url: "https://app.example" }, { prefix: "/auth/" }],
        },
        {
          domain: "shop.example",
          redirects: [],
          headers: [],
          upstreams: [{ prefix: "/cart/", url: "https://cart.example" }],
        },
      ],
    };
    const quiet = (extra: Pick<AdapterDefinition, "upstreams">) =>
      defineAdapter({ name: "quiet", limits: {}, compileTree: () => [], ...extra });

    it("is refused by an adapter that does not route it", () => {
      expect(() => quiet({}).compile(routed)).toThrow(
        new ConfigError(
          `Edge target "quiet": 1 tree sends a prefix to an app, which this target cannot route — compile with an adapter that routes build.routing.upstreams, or remove build.routing.upstreams and route each prefix in the host's own configuration:
  the default tree's prefix "/api/" (build.routing.upstreams)`,
        ),
      );
    });

    it("reaches the compiler of an adapter that routes it without a url", () => {
      expect(quiet({ upstreams: { url: "refused" } }).compile(routed).artifacts).toEqual([]);
    });

    it("reaches the compiler of an adapter that proxies it to its url", () => {
      const withUrl: RoutingManifest = {
        ...FIXTURE,
        trees: [
          {
            redirects: [],
            headers: [],
            upstreams: [{ prefix: "/api/", url: "https://app.example" }],
          },
        ],
      };
      expect(quiet({ upstreams: { url: "required" } }).compile(withUrl).artifacts).toEqual([]);
    });

    it("is refused, per tree, where an adapter that proxies finds no url", () => {
      expect(() => quiet({ upstreams: { url: "required" } }).compile(proxied)).toThrow(
        new ConfigError(
          `Edge target "quiet": 1 tree sends a prefix to an app with no url, which this target needs to reach the app — set url on each to the https origin the deployed app answers at, such as "https://app.example":
  the default tree's prefix "/auth/" (build.routing.upstreams)`,
        ),
      );
    });

    it("is refused, per tree, where an adapter that routes without a url finds one", () => {
      expect(() => quiet({ upstreams: { url: "refused" } }).compile(proxied)).toThrow(
        new ConfigError(
          `Edge target "quiet": 2 trees send prefixes to apps at a url, which this target does not proxy to — remove url from each, and run the app where this target routes the prefix without one:
  the default tree's prefix "/api/" (build.routing.upstreams)
  the "shop.example" tree's prefix "/cart/" (build.routing.upstreams)`,
        ),
      );
    });

    it("is refused with the adapter's own fix for a url, where it names one", () => {
      expect(() =>
        quiet({ upstreams: { url: "refused", fix: "run it on the host" } }).compile(proxied),
      ).toThrow(/does not proxy to — run it on the host:/);
    });

    it("reaches the compiler, url or not, of an adapter that decides per prefix", () => {
      const optional = quiet({ upstreams: { url: "optional", fix: "bind it" } });
      expect(optional.compile(routed).artifacts).toEqual([]);
      expect(optional.compile(proxied).artifacts).toEqual([]);
    });

    it("names the optional policy's fix on the adapter's own missing-url fault", () => {
      const adapter = defineAdapter({
        name: "picky",
        limits: {},
        upstreams: { url: "optional", fix: "bind it, or set url" },
        compileTree: (tree, faults) => {
          faults.push({ kind: "upstream-url-missing", line: `${tree.domain ?? "default"}'s "/auth/"` });
          return [];
        },
      });
      expect(() => adapter.compile(routed)).toThrow(
        new ConfigError(
          `Edge target "picky": 1 tree sends a prefix to an app with no url, which this target needs to reach the app — bind it, or set url:
  default's "/auth/"`,
        ),
      );
    });

    it("is not refused when its prefix list is empty", () => {
      const empty = { ...routed, trees: [{ redirects: [], headers: [], upstreams: [] }] };
      expect(quiet({}).compile(empty).artifacts).toEqual([]);
    });
  });

  it("reports an adapter's own faults, one paragraph per subject and fix, with the document's and the base's", () => {
    const odd = { one: "option is odd", many: "options are odd" };
    const adapter = defineAdapter({
      name: "own",
      limits: {},
      checkManifest: (manifest, faults) => {
        faults.push({ kind: "adapter", subject: odd, fix: "even it", line: `${String(manifest.trees.length)} trees` });
      },
      compileTree: (tree, faults) => {
        faults.push({ kind: "adapter", subject: odd, fix: "even it", line: tree.domain ?? "default" });
        faults.push({ kind: "unexpressible", line: "a value" });
        return [];
      },
    });
    expect(() => adapter.compile(FIXTURE)).toThrow(
      new ConfigError(
        `Edge target "own": 3 options are odd — even it:
  2 trees
  default
  shop.example

Edge target "own": 2 values cannot be expressed by this target — change each value as its line says, or compile a target that can express it:
  a value
  a value`,
      ),
    );
  });

  it("hands checkManifest the site compile was given", () => {
    const seen: unknown[] = [];
    const adapter = defineAdapter({
      name: "site",
      limits: {},
      checkManifest: (_manifest, _faults, site) => seen.push(site),
      compileTree: () => [],
    });
    adapter.compile(FIXTURE, { root: "/site" });
    adapter.compile(FIXTURE);
    expect(seen).toEqual([{ root: "/site" }, undefined]);
  });

  it("attaches a fault's cause, and several causes as one AggregateError", () => {
    const unread = { one: "file is unread", many: "files are unread" };
    const first = new Error("first");
    const second = new Error("second");
    const one = defineAdapter({
      name: "one",
      limits: {},
      checkManifest: (_manifest, faults) => {
        faults.push({ kind: "adapter", subject: unread, fix: "read it", line: "a", cause: first });
      },
      compileTree: () => [],
    });
    const thrown = (adapter: typeof one): ConfigError => {
      try {
        adapter.compile({ ...FIXTURE, trees: [] });
      } catch (error) {
        return error as ConfigError;
      }
      return expect.unreachable("expected a refusal");
    };
    expect(thrown(one).cause).toBe(first);
    const two = defineAdapter({
      name: "two",
      limits: {},
      checkManifest: (_manifest, faults) => {
        faults.push({ kind: "adapter", subject: unread, fix: "read it", line: "a", cause: first });
        faults.push({ kind: "adapter", subject: unread, fix: "read it", line: "b", cause: second });
      },
      compileTree: () => [],
    });
    const cause = thrown(two).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([first, second]);
  });
});
