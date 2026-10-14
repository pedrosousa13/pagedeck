import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileNginx } from "./nginx.js";
import type { NginxOptions } from "./nginx.js";

export type { NginxOptions } from "./nginx.js";

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export function nginx(options: NginxOptions = {}): EdgeAdapter {
  return defineAdapter({
    name: "nginx",
    limits: {},
    compileTree: (tree, faults) => compileNginx(tree, faults, options),
    unsupportedFix: UNSUPPORTED_FIX,
    upstreams: { url: "required" },
  });
}
