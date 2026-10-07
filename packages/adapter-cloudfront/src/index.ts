import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
  compileCloudFront,
} from "./cloudfront.js";

export {
  CLOUDFRONT_FUNCTION_LIMIT,
  CLOUDFRONT_KVS_LIMIT,
} from "./cloudfront.js";

export interface CloudFrontOptions {
  /** Byte ceiling per role; defaults to CloudFront's function limit and KeyValueStore quota. */
  limits?: Partial<Record<"function" | "dataset", number>>;
}

export function cloudfront(options: CloudFrontOptions = {}): EdgeAdapter {
  const limits = {
    function: CLOUDFRONT_FUNCTION_LIMIT,
    dataset: CLOUDFRONT_KVS_LIMIT,
    ...options.limits,
  };
  return defineAdapter({
    name: "cloudfront-function",
    limits,
    compileTree: (tree) => compileCloudFront(tree, limits.function),
  });
}
