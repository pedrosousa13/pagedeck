import { expect, test } from "vitest";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_FACADE_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
} from "./marker.js";

test("the marker names are the contract both sides import", () => {
  expect(ISLAND_TAG).toBe("fw-island");
  expect(ISLAND_PREFIX_ATTRIBUTE).toBe("data-fw-prefix");
  expect(ISLAND_COMPONENT_ATTRIBUTE).toBe("data-fw-component");
  expect(ISLAND_MODE_ATTRIBUTE).toBe("data-fw-mode");
  expect(ISLAND_PROPS_ATTRIBUTE).toBe("data-fw-props");
});

test("the slot names are the contract both sides import", () => {
  expect(ISLAND_SLOT_TAG).toBe("fw-slot");
  expect(ISLAND_SLOT_ATTRIBUTE).toBe("data-fw-slot");
  expect(ISLAND_TEMPLATE_ATTRIBUTE).toBe("data-fw-template");
});

test("the facade placeholder name is the contract the build and its loader share", () => {
  expect(ISLAND_FACADE_ATTRIBUTE).toBe("data-fw-facade");
});

test("both tags are custom elements, which the HTML parser requires a hyphen for", () => {
  expect(ISLAND_TAG).toContain("-");
  expect(ISLAND_SLOT_TAG).toContain("-");
});
