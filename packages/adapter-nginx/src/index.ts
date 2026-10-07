import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileNginx } from "./nginx.js";

export function nginx(): EdgeAdapter {
  return defineAdapter({
    name: "nginx",
    limits: {},
    compileTree: compileNginx,
  });
}
