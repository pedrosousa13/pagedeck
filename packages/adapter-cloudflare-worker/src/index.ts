import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { CLOUDFLARE_WORKER_LIMIT, compileWorker } from "./cloudflare-worker.js";

export {
  CLOUDFLARE_WORKER_LIMIT,
  WORKER_ORIGIN_BINDING,
} from "./cloudflare-worker.js";

export interface CloudflareWorkerOptions {
  /** Byte ceiling for `worker.js`; defaults to the Workers script limit. */
  limits?: Partial<Record<"edge-module", number>>;
}

export function cloudflareWorker(
  options: CloudflareWorkerOptions = {},
): EdgeAdapter {
  return defineAdapter({
    name: "cloudflare-worker",
    limits: { "edge-module": CLOUDFLARE_WORKER_LIMIT, ...options.limits },
    compileTree: compileWorker,
  });
}
