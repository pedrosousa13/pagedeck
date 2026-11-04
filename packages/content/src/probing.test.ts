import { expect, test } from "vitest";
import { reasonOf } from "./probing.js";

test("a long message with no address passes through in linear time", () => {
  const message = "a.".repeat(50_000);

  expect(reasonOf(new Error(message), "/a.jpg")).toBe(message);
}, 2_000);
