import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { CLOUDFLARE_WORKER_LIMIT, compileWorker } from "./cloudflare-worker.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export {
  CLOUDFLARE_WORKER_LIMIT,
  WORKER_ORIGIN_BINDING,
} from "./cloudflare-worker.js";

export interface CloudflareWorkerOptions {
  limits?: Partial<Record<"edge-module", number>>;
}

export function cloudflareWorker(
  options: CloudflareWorkerOptions = {},
): EdgeAdapter {
  return defineAdapter({
    name: "cloudflare-worker",
    limits: { "edge-module": CLOUDFLARE_WORKER_LIMIT, ...options.limits },
    compileTree: compileWorker,
    unsupportedFix: UNSUPPORTED_FIX,
  });
}
