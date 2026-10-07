import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileNginx } from "./nginx.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export function nginx(): EdgeAdapter {
  return defineAdapter({
    name: "nginx",
    limits: {},
    compileTree: compileNginx,
    unsupportedFix: UNSUPPORTED_FIX,
  });
}
