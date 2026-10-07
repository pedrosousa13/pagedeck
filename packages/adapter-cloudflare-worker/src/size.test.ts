import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { EdgeArtifact } from "@pagedeck/edge";

import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import { bytes, manifestOf } from "../../edge/src/size.test-support.js";
import { CLOUDFLARE_WORKER_LIMIT, cloudflareWorker } from "./index.js";
import { interpretWorker } from "./interpret.test-support.js";

describe("a Worker's redirect table", () => {
  function workerOf(count: number): readonly EdgeArtifact[] {
    return cloudflareWorker().compile(manifestOf(count)).artifacts;
  }

  it("stays in the one script at a count CloudFront moves to a store", () => {
    const artifacts = workerOf(400);
    expect(
      artifacts.map((artifact) => `${artifact.role} ${artifact.path}`),
    ).toEqual(["edge-module worker.js"]);
    expect(bytes(artifacts[0] as EdgeArtifact)).toBeLessThanOrEqual(
      CLOUDFLARE_WORKER_LIMIT,
    );
  });

  it("still answers every request the way the document says", async () => {
    const manifest = manifestOf(400);
    const artifacts = workerOf(400);
    for (const request of [
      { path: "/old-00000", found: false },
      { path: "/old-00399", found: false },
      { path: "/old-00400", found: false },
      { path: "/live", found: true },
    ]) {
      expect(comparable(await interpretWorker(artifacts, request))).toEqual(
        comparable(resolveRequest(manifest, request)),
      );
    }
  });

  it("is measured against a limit like every other artifact", () => {
    expect(() =>
      cloudflareWorker({ limits: { "edge-module": 1024 } }).compile(
        manifestOf(20),
      ),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 1 artifact exceeds its size limit — reduce the rule set, or raise the limit if the host's is higher:
  the default tree's "worker.js" — ${String(bytes(workerOf(20)[0] as EdgeArtifact))} bytes, limit 1024`,
      ),
    );
  });

  it("defaults that limit to the Workers script limit", () => {
    const perRule =
      bytes(workerOf(2)[0] as EdgeArtifact) -
      bytes(workerOf(1)[0] as EdgeArtifact);
    const count = Math.ceil((CLOUDFLARE_WORKER_LIMIT / perRule) * 1.1);
    let thrown: unknown;
    try {
      cloudflareWorker().compile(manifestOf(count));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(
      new RegExp(`"worker\\.js" — \\d+ bytes, limit ${String(CLOUDFLARE_WORKER_LIMIT)}$`),
    );
  });
});
