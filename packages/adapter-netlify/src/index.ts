import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileNetlify } from "./netlify.js";

export function netlify(): EdgeAdapter {
  return defineAdapter({
    name: "netlify",
    limits: {},
    compileTree: compileNetlify,
  });
}
