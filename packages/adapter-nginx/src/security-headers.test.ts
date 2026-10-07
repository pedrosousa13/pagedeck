import { describe, expect, it } from "vitest";

import {
  contentsOf,
  SECURITY_MANIFEST,
} from "../../edge/src/conformance.test-support.js";
import { nginx } from "./index.js";

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches the nginx config as three add_header directives", () => {
    const conf = contentsOf(nginx(), SECURITY_MANIFEST, "routing.conf");
    expect(conf).toContain(
      'add_header "X-Content-Type-Options" "nosniff" always;',
    );
    expect(conf).toContain('add_header "X-Frame-Options" "DENY" always;');
    expect(conf).toContain(
      'add_header "Referrer-Policy" "strict-origin-when-cross-origin" always;',
    );
  });
});
