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
    describe: (artifact) =>
      artifact.slot === undefined
        ? `${treeOf(artifact.domain)}'s "${artifact.path}"`
        : `${treeOf(artifact.domain)}'s ${artifact.slot} function`,
  });
}
