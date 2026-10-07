import { describe, expect, it } from "vitest";

import { NEVER, textOf } from "../../edge/src/conformance.test-support.js";
import { nginx } from "./index.js";

describe("the claim the adapters are checked against", () => {
  it("leaves the 404 page's other spelling alone", () => {
    expect(textOf(nginx(), NEVER)).not.toContain('"/en/404/"');
  });
});
