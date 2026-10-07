import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { defineAdapter } from "./adapter.js";
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
        `Edge target "stub": 1 value cannot be expressed by this target — remove the character, or compile a target that can express it:
  tree "shop.example"

Edge target "stub": 2 artifacts exceed their size limit — reduce the rule set, or raise the limit if the host's is higher:
  the default tree's "/stub" — 17 bytes, limit 16
  the default tree's "/stub" — 17 bytes, limit 16`,
      ),
    );
  });
});
