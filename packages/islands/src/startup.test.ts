import { expect, test } from "vitest";
import * as marker from "./marker.js";
import { MARKER_NAMES } from "./startup.js";

test("the startup module restates the marker names the build writes", () => {
  expect(MARKER_NAMES).toEqual({
    island: marker.ISLAND_TAG,
    mode: marker.ISLAND_MODE_ATTRIBUTE,
    slot: marker.ISLAND_SLOT_TAG,
  });
});
