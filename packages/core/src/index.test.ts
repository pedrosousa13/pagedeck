import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CORE_VERSION, workspaceVersions } from "./index.js";

function versionOf(dir: string): string {
  return (
    JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", dir, "package.json"), "utf8"),
    ) as { version: string }
  ).version;
}

test("core exposes the version its manifest declares", () => {
  expect(CORE_VERSION).toBe(versionOf("core"));
});

test("core imports from @pagedeck/content across the package boundary", () => {
  expect(workspaceVersions()).toEqual({
    core: versionOf("core"),
    content: versionOf("content"),
  });
});

test("core exposes the CLI's exit vocabulary, the contract CI branches on", async () => {
  const { EXIT_CODES } = await import("./index.js");

  expect(EXIT_CODES).toEqual({ success: 0, syncFailed: 1, configError: 2 });
});

test("core exposes the stderr marker, the contract a spawned run is read by", async () => {
  const { DIAGNOSTIC_MARKER } = await import("./index.js");

  expect(DIAGNOSTIC_MARKER).toBe("pagedeck:");
});
