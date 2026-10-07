import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as islands from "./index.js";
import {
  defineComponents,
  getComponent,
  ISLANDS_VERSION,
  mergeComponents,
  RegistryError,
  resolveComponent,
  resolveHydrationMode,
  wrapInProviders,
} from "./index.js";

test("islands exposes the version its manifest declares", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  expect(ISLANDS_VERSION).toBe(manifest.version);
});

test("islands exposes the component registry API", () => {
  expect(typeof defineComponents).toBe("function");
  expect(typeof mergeComponents).toBe("function");
  expect(typeof getComponent).toBe("function");
  expect(typeof resolveComponent).toBe("function");
  expect(typeof resolveHydrationMode).toBe("function");
  expect(typeof RegistryError).toBe("function");
});

test("islands exposes the provider stack both sides apply", () => {
  expect(typeof wrapInProviders).toBe("function");
});

test("the client runtime is reached through its own entry, not the index", async () => {
  expect(islands).not.toHaveProperty("hydrateIslands");

  const runtime = await import("@pagedeck/islands/runtime");
  expect(typeof runtime.hydrateIslands).toBe("function");
});

test("slot adoption is reached through its own entry, and SlotContent through both", async () => {
  expect(typeof islands.SlotContent).toBe("object");
  expect(islands).not.toHaveProperty("adoptSlots");

  const slot = await import("@pagedeck/islands/slot");
  expect(typeof slot.adoptSlots).toBe("function");
});
