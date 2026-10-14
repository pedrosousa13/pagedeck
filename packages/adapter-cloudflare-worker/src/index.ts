import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { CLOUDFLARE_WORKER_LIMIT, compileWorker } from "./cloudflare-worker.js";
import { checkBindings, NO_URL_FIX } from "./upstreams.js";
import type { ServiceBindings } from "./upstreams.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export {
  CLOUDFLARE_WORKER_LIMIT,
  WORKER_ORIGIN_BINDING,
} from "./cloudflare-worker.js";
export type { ServiceBindings } from "./upstreams.js";

export interface CloudflareWorkerOptions {
  limits?: Partial<Record<"edge-module", number>>;
  /** The service binding each upstream prefix's app is reached through, such as `{ "/api/": { binding: "APP" } }`. */
  upstreams?: ServiceBindings;
}

export function cloudflareWorker(
  options: CloudflareWorkerOptions = {},
): EdgeAdapter {
  const bindings = options.upstreams ?? {};
  return defineAdapter({
    name: "cloudflare-worker",
    limits: { "edge-module": CLOUDFLARE_WORKER_LIMIT, ...options.limits },
    compileTree: (tree, faults) => compileWorker(tree, faults, bindings),
    checkManifest: (manifest, faults) => {
      checkBindings(bindings, manifest, faults);
    },
    unsupportedFix: UNSUPPORTED_FIX,
    upstreams: { url: "optional", fix: NO_URL_FIX },
  });
}
