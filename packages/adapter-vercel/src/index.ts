import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileVercel } from "./vercel.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

const UPSTREAM_FIX =
  "deploy with cloudflarePages(), the one adapter that routes a prefix to an app so far, or remove build.routing.upstreams and route each prefix in the host's own configuration";

export function vercel(): EdgeAdapter {
  return defineAdapter({
    name: "vercel",
    limits: {},
    compileTree: compileVercel,
    unsupportedFix: UNSUPPORTED_FIX,
    upstreamFix: UPSTREAM_FIX,
  });
}
