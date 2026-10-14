import { defineAdapter, treeOf } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
  compileCloudFront,
} from "./cloudfront.js";
import type { CloudFrontArtifact } from "./cloudfront.js";
import { CLOUDFRONT_CACHE_BEHAVIOR_QUOTA } from "./upstreams.js";

export {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
} from "./cloudfront.js";
export { CLOUDFRONT_CACHE_BEHAVIOR_QUOTA } from "./upstreams.js";
export type {
  CloudFrontArtifact,
  EventSlot,
  FunctionRuntime,
} from "./cloudfront.js";

export interface CloudFrontOptions {
  /** `cacheBehaviors` counts behaviours per distribution, not bytes. */
  limits?: Partial<Record<"function" | "dataset" | "cacheBehaviors", number>>;
}

export function cloudfront(
  options: CloudFrontOptions = {},
): EdgeAdapter<CloudFrontArtifact> {
  const { cacheBehaviors, ...bytes } = {
    function: CLOUDFRONT_FUNCTION_LIMIT,
    dataset: CLOUDFRONT_KVS_LIMIT,
    cacheBehaviors: CLOUDFRONT_CACHE_BEHAVIOR_QUOTA,
    ...options.limits,
  };
  return defineAdapter({
    name: "cloudfront-function",
    limits: bytes,
    compileTree: (tree, faults) =>
      compileCloudFront(tree, bytes.function, cacheBehaviors, faults),
    upstreams: { url: "required" },
    describe: (artifact) =>
      artifact.slot === undefined
        ? `${treeOf(artifact.domain)}'s "${artifact.path}"`
        : `${treeOf(artifact.domain)}'s ${artifact.slot} function`,
  });
}
