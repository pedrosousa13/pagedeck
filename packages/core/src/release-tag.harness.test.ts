import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { releaseTagFault } from "./release-tag.harness.js";
import { PUBLIC_PACKAGES, PUBLIC_VERSION } from "./public-packages.test-support.js";

const SCRIPT = join(import.meta.dirname, "release-tag.harness.ts");

const WORKSPACE = [
  { path: "packages/core/package.json", name: "@pagedeck/core", version: "0.2.0" },
  { path: "packages/edge/package.json", name: "@pagedeck/edge", version: "0.2.0" },
  { path: "packages/site/package.json", name: "@pagedeck/site", version: "0.0.0", private: true },
];

test("a tag whose version every public package carries is no fault, whatever a private package carries", () => {
  expect(releaseTagFault("v0.2.0", WORKSPACE)).toBeUndefined();
});

test("a mismatched tag names every public package that differs, and says the public packages disagree", () => {
  const manifests = [
    ...WORKSPACE,
    { path: "packages/search/package.json", name: "@pagedeck/search", version: "0.1.0" },
    { path: "packages/islands/package.json", name: "@pagedeck/islands" },
  ];

  expect(releaseTagFault("v0.2.0", manifests)).toBe(
    'Release tag "v0.2.0": 2 public packages do not carry version "0.2.0", so this run publishes nothing. The public packages carry different versions ("0.1.0", "0.2.0", no version), so set every one\'s "version" to "0.2.0" and tag that commit:\n' +
      '  @pagedeck/search (packages/search/package.json) is "0.1.0"\n' +
      "  @pagedeck/islands (packages/islands/package.json) declares no version",
  );
});

test("a mismatched tag, when every public package carries one version, offers that version's tag", () => {
  expect(releaseTagFault("v0.3.0", WORKSPACE)).toBe(
    'Release tag "v0.3.0": 2 public packages do not carry version "0.3.0", so this run publishes nothing. Set each one\'s "version" to "0.3.0" and tag that commit, or push the tag "v0.2.0", the version every public package carries:\n' +
      '  @pagedeck/core (packages/core/package.json) is "0.2.0"\n' +
      '  @pagedeck/edge (packages/edge/package.json) is "0.2.0"',
  );
});

test("a tag without the leading v, when every public package carries one version, offers that version's tag", () => {
  expect(releaseTagFault("0.3.0", WORKSPACE)).toBe(
    'Release tag "0.3.0": does not start with "v", so it names no version and this run publishes nothing. Push the tag "v0.2.0", the version every public package carries',
  );
});

test("a tag without the leading v, when the public packages disagree, asks for one version first", () => {
  const manifests = [
    ...WORKSPACE,
    { path: "packages/search/package.json", name: "@pagedeck/search", version: "0.1.0" },
  ];

  expect(releaseTagFault("0.2.0", manifests)).toBe(
    'Release tag "0.2.0": does not start with "v", so it names no version and this run publishes nothing. The public packages carry different versions ("0.1.0", "0.2.0"), so set every one\'s "version" to one version first, then push "v" followed by it',
  );
});

test("no tag at all asks for the pushed tag as the argument", () => {
  expect(releaseTagFault("", WORKSPACE)).toBe(
    'Release tag: none was given, so this run publishes nothing. Pass the pushed tag as the first argument, as release.yml does with "$GITHUB_REF_NAME"',
  );
});

function runScript(tag: string): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, tag], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status, stdout, stderr };
}

test("run against this workspace, the script passes the public version's tag", () => {
  const { status, stdout, stderr } = runScript(`v${PUBLIC_VERSION}`);

  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(stdout).toContain(`v${PUBLIC_VERSION}`);
}, 30_000);

test("run against this workspace, the script refuses a mismatched tag and names each public package", () => {
  const { status, stderr } = runScript("v99.0.0");

  expect(status).toBe(1);
  expect(stderr).toContain(
    `${String(PUBLIC_PACKAGES.length)} public packages do not carry version "99.0.0"`,
  );
  for (const dir of PUBLIC_PACKAGES) {
    expect(stderr).toContain(`(packages/${dir}/package.json) is "${PUBLIC_VERSION}"`);
  }
}, 30_000);
