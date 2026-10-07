import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CONTENT_VERSION, openStore, openStoreReadOnly } from "./index.js";

test("content exposes the version its manifest declares", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  expect(CONTENT_VERSION).toBe(manifest.version);
});

test("content exposes the store API", () => {
  expect(typeof openStore).toBe("function");
  expect(typeof openStoreReadOnly).toBe("function");
});
