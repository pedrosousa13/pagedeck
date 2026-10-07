import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";

import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import { bytes, manifestOf } from "../../edge/src/size.test-support.js";
import {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
  cloudfront,
} from "./index.js";
import type { CloudFrontArtifact } from "./index.js";
import { interpretCloudFront } from "./interpret.test-support.js";

function artifactsOf(count: number): readonly CloudFrontArtifact[] {
  return cloudfront().compile(manifestOf(count)).artifacts;
}

describe("a redirect set that fits", () => {
  const artifacts = artifactsOf(20);

  it("inlines the table into the function and emits no dataset", () => {
    expect(
      artifacts.map((artifact) => `${artifact.role} ${artifact.path}`),
    ).toEqual([
      "function routing.request.js",
      "distribution-config error-responses.json",
    ]);
  });

  it("stays under the limit", () => {
    const fn = artifacts[0];
    expect(bytes(fn as CloudFrontArtifact)).toBeLessThanOrEqual(
      CLOUDFRONT_FUNCTION_LIMIT,
    );
  });

  it("names the runtime the inline form needs", () => {
    expect((artifacts[0] as CloudFrontArtifact).runtime).toBe("cloudfront-js-1.0");
  });
});

describe("a redirect set that does not fit", () => {
  // About four times what fits inline, so the rule count forces the dataset form.
  const count = 400;
  const artifacts = artifactsOf(count);

  it("moves the table into a dataset and keeps the function", () => {
    expect(
      artifacts.map((artifact) => `${artifact.role} ${artifact.path}`),
    ).toEqual([
      "function routing.request.js",
      "function-config routing.request.config.json",
      "dataset routing.kvs.json",
      "distribution-config error-responses.json",
    ]);
  });

  it("names the runtime the dataset form needs", () => {
    expect((artifacts[0] as CloudFrontArtifact).runtime).toBe("cloudfront-js-2.0");
  });

  it("leaves the function under the limit", () => {
    const fn = artifacts[0] as CloudFrontArtifact;
    expect(bytes(fn)).toBeLessThanOrEqual(CLOUDFRONT_FUNCTION_LIMIT);
  });

  it("keeps the function the same size whatever the rule count", () => {
    const larger = artifactsOf(count * 4);
    expect(bytes(larger[0] as CloudFrontArtifact)).toBe(
      bytes(artifacts[0] as CloudFrontArtifact),
    );
  });

  it("carries every rule in the dataset", () => {
    const dataset = artifacts.find((artifact) => artifact.role === "dataset");
    const parsed = JSON.parse((dataset as CloudFrontArtifact).contents) as {
      data: readonly { key: string; value: string }[];
    };
    expect(parsed.data).toHaveLength(count * 3);
    const rowFor = (key: string): unknown =>
      parsed.data.find((row) => row.key === key);
    expect(rowFor("/old-00000")).toEqual({
      key: "/old-00000",
      value:
        '{"to":"/new-00000","status":301,"description":"Moved Permanently"}',
    });
    expect(rowFor("/old-00000/")).toEqual({
      key: "/old-00000/",
      value:
        '{"to":"/new-00000","status":301,"description":"Moved Permanently"}',
    });
    expect(rowFor("/new-00000/")).toEqual({
      key: "/new-00000/",
      value:
        '{"to":"/new-00000","status":308,"description":"Permanent Redirect"}',
    });
  });

  it("still answers every request the way the document says", async () => {
    const manifest = manifestOf(count);
    for (const request of [
      { path: "/old-00000", found: false },
      { path: "/old-00399", found: false },
      { path: "/old-00400", found: false },
      { path: "/live", found: true },
    ]) {
      expect(comparable(await interpretCloudFront(artifacts, request))).toEqual(
        comparable(resolveRequest(manifest, request)),
      );
    }
  });
});

describe("the store the dataset form needs", () => {
  const moved = artifactsOf(400);
  const inline = artifactsOf(20);

  function configOf(artifacts: readonly CloudFrontArtifact[]): {
    Runtime: string;
    Comment: string;
    KeyValueStoreAssociations: {
      Quantity: number;
      Items: readonly { KeyValueStoreARN: string }[];
    };
  } {
    const config = artifacts.find(
      (artifact) => artifact.role === "function-config",
    );
    return JSON.parse((config as CloudFrontArtifact).contents) as never;
  }

  it("emits the association fragment beside the function and the dataset", () => {
    expect(
      moved.map((artifact) => `${artifact.role} ${artifact.path}`),
    ).toEqual([
      "function routing.request.js",
      "function-config routing.request.config.json",
      "dataset routing.kvs.json",
      "distribution-config error-responses.json",
    ]);
  });

  it("associates exactly one store, on the runtime the function needs", () => {
    const config = configOf(moved);
    expect(config.Runtime).toBe((moved[0] as CloudFrontArtifact).runtime);
    expect(config.KeyValueStoreAssociations.Quantity).toBe(1);
    expect(config.KeyValueStoreAssociations.Items).toHaveLength(1);
  });

  it("names the dataset the operator has to import into that store", () => {
    const named = configOf(moved).Comment;
    const dataset = moved.find((artifact) => artifact.role === "dataset");
    expect(named).toContain((dataset as CloudFrontArtifact).path);
  });

  it("leaves the ARN as one named substitution, and nothing else", () => {
    const contents = moved.find(
      (artifact) => artifact.role === "function-config",
    )?.contents;
    expect(
      [...(contents ?? "").matchAll(/\$\{[A-Z_]+\}/g)].map(([m]) => m),
    ).toEqual(["${PAGEDECK_ROUTING_KVS_ARN}"]);
  });

  it("emits no association when the table stays in the function", () => {
    expect(inline.some((artifact) => artifact.role === "function-config")).toBe(
      false,
    );
  });

  it("leaves no function needing a store the artifact set does not carry", () => {
    for (const artifacts of [moved, inline]) {
      const reads = artifacts.filter(
        (artifact) => artifact.runtime === "cloudfront-js-2.0",
      );
      const roles = new Set(artifacts.map((artifact) => artifact.role));
      expect(roles.has("function-config")).toBe(reads.length > 0);
      expect(roles.has("dataset")).toBe(reads.length > 0);
    }
  });
});

describe("the dataset the table moves into", () => {
  it("is measured against a limit like every other artifact", () => {
    expect(() =>
      cloudfront({ limits: { dataset: 1024 } }).compile(manifestOf(400)),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudfront-function": 1 artifact exceeds its size limit — reduce the rule set, or raise the limit if the host's is higher:
  the default tree's "routing.kvs.json" — 162019 bytes, limit 1024`,
      ),
    );
  });

  it("defaults that limit to the KeyValueStore's own quota", () => {
    const count = Math.ceil((CLOUDFRONT_KVS_LIMIT / 150) * 1.5);
    // Compiled once and asserted twice: a set this size is CPU-bound, and two compiles ran
    // close to the 5s default under load (#183).
    let thrown: unknown;
    try {
      cloudfront().compile(manifestOf(count));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(/routing\.kvs\.json/);
  });
});
