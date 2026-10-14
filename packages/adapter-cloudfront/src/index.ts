import { defineAdapter, treeOf } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
  compileCloudFront,
} from "./cloudfront.js";
import type { CloudFrontArtifact } from "./cloudfront.js";

export {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
} from "./cloudfront.js";
export type {
  CloudFrontArtifact,
  EventSlot,
  FunctionRuntime,
} from "./cloudfront.js";

export interface CloudFrontOptions {
  limits?: Partial<Record<"function" | "dataset", number>>;
}

const UPSTREAM_FIX =
  "deploy with cloudflarePages(), the one adapter that routes a prefix to an app so far, or remove build.routing.upstreams and route each prefix in the host's own configuration";

export function cloudfront(
  options: CloudFrontOptions = {},
): EdgeAdapter<CloudFrontArtifact> {
  const limits = {
    function: CLOUDFRONT_FUNCTION_LIMIT,
    dataset: CLOUDFRONT_KVS_LIMIT,
    ...options.limits,
  };
  return defineAdapter({
    name: "cloudfront-function",
    limits,
    compileTree: (tree) => compileCloudFront(tree, limits.function),
    upstreamFix: UPSTREAM_FIX,
    describe: (artifact) =>
      artifact.slot === undefined
        ? `${treeOf(artifact.domain)}'s "${artifact.path}"`
        : `${treeOf(artifact.domain)}'s ${artifact.slot} function`,
  });
}
