import { describe, expect, it } from "vitest";

import {
  contentsOf,
  SECURITY_MANIFEST,
} from "../../edge/src/conformance.test-support.js";
import { vercel } from "./index.js";

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches vercel.json as one rule over the site", () => {
    expect(JSON.parse(contentsOf(vercel(), SECURITY_MANIFEST, "/vercel.json")).headers).toEqual([
      {
        source: "/:rest(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]);
  });
});
