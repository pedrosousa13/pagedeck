import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileCloudflarePages } from "./cloudflare-pages.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export function cloudflarePages(): EdgeAdapter {
  return defineAdapter({
    name: "cloudflare-pages",
    limits: {},
    compileTree: compileCloudflarePages,
    unsupportedFix: UNSUPPORTED_FIX,
  });
}
