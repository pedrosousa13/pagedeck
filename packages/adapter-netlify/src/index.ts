import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileNetlify } from "./netlify.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export function netlify(): EdgeAdapter {
  return defineAdapter({
    name: "netlify",
    limits: {},
    compileTree: compileNetlify,
    unsupportedFix: UNSUPPORTED_FIX,
  });
}
