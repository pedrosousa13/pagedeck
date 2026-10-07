import { describe, expect, it } from "vitest";

import {
  contentsOf,
  SECURITY_MANIFEST,
} from "../../edge/src/conformance.test-support.js";
import { netlify } from "./index.js";

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches _headers as one block under the prefix", () => {
    expect(contentsOf(netlify(), SECURITY_MANIFEST, "/_headers")).toContain(
      [
        "/*",
        "  X-Content-Type-Options: nosniff",
        "  X-Frame-Options: DENY",
        "  Referrer-Policy: strict-origin-when-cross-origin",
      ].join("\n"),
    );
  });
});
