import { describe, expect, it } from "vitest";

import {
  contentsOf,
  SECURITY_MANIFEST,
} from "../../edge/src/conformance.test-support.js";
import { cloudfront } from "./index.js";

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches the CloudFront viewer-response table as three fields", () => {
    expect(contentsOf(cloudfront(), SECURITY_MANIFEST, "routing.response.js")).toContain(
      'var HEADERS = Object.freeze([\n  { prefix: "/", set: [{ name: "x-content-type-options", value: "nosniff" }, { name: "x-frame-options", value: "DENY" }, { name: "referrer-policy", value: "strict-origin-when-cross-origin" }] },\n]);',
    );
  });
});
