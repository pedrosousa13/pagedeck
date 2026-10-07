import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileVercel } from "./vercel.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export function vercel(): EdgeAdapter {
  return defineAdapter({
    name: "vercel",
    limits: {},
    compileTree: compileVercel,
    unsupportedFix: UNSUPPORTED_FIX,
  });
}
