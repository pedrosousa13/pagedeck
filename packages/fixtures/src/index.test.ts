import { expect, test } from "vitest";
import {
  FIXTURES_VERSION,
  createFixtureLoader,
  loadFixtureStore,
} from "./index.js";

test("fixtures exposes a version", () => {
  expect(FIXTURES_VERSION).toBe("0.0.0");
});

test("fixtures exposes the loader and the harness", () => {
  expect(typeof createFixtureLoader).toBe("function");
  expect(typeof loadFixtureStore).toBe("function");
});
