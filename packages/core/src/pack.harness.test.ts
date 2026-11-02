import { expect, test } from "vitest";
import { newestVite, rolldownVersionsFault, viteRolldownFault } from "./rolldown-pin.test-support.js";

const CORE = { name: "@pagedeck/core", version: "0.3.1", depField: "dependencies" };

test("an install holding one rolldown version is no fault, however many packages depend on it", () => {
  const why = [
    {
      name: "rolldown",
      version: "1.2.16",
      dependents: [CORE, { name: "vite", version: "8.3.5", dependents: [CORE] }],
    },
  ];

  expect(rolldownVersionsFault("/tmp/site", why)).toBeUndefined();
});

test("an install holding two rolldown versions names each version and the packages that brought it", () => {
  const why = [
    { name: "rolldown", version: "1.2.13", dependents: [CORE] },
    {
      name: "rolldown",
      version: "1.2.16",
      dependents: [{ name: "vite", version: "8.3.5", dependents: [CORE] }],
    },
  ];

  expect(rolldownVersionsFault("/tmp/site", why)).toBe(
    'Install "/tmp/site": holds 2 rolldown versions, so vite bundles with a different rolldown than the one @pagedeck/core pins — set "rolldown" in packages/core/package.json to a version inside the rolldown range of the newest vite core\'s "vite" range admits (docs/maintaining/packaging.md, "The published tarball"):\n' +
      "  rolldown 1.2.13, brought by @pagedeck/core 0.3.1\n" +
      "  rolldown 1.2.16, brought by vite 8.3.5",
  );
});

const LATEST = { viteRange: "^8.3.3", vite: "8.3.5", rolldownRange: "~1.2.14" };

test("a rolldown pin inside the rolldown range of the newest vite core's range admits is no fault", () => {
  expect(viteRolldownFault({ ...LATEST, pin: "1.2.16" })).toBeUndefined();
  expect(viteRolldownFault({ ...LATEST, pin: "1.2.14" })).toBeUndefined();
});

test("a rolldown pin outside that range names the pin, the vite version, its rolldown range and core's vite range", () => {
  expect(viteRolldownFault({ ...LATEST, pin: "1.2.13" })).toBe(
    'Package "@pagedeck/core": its rolldown pin "1.2.13" is outside "~1.2.14", the rolldown range of vite 8.3.5, the newest vite its range "^8.3.3" admits, so a fresh install holds two rolldowns — move "rolldown" in packages/core/package.json to a version "~1.2.14" admits (docs/maintaining/packaging.md, "The published tarball")',
  );
  expect(viteRolldownFault({ ...LATEST, pin: "1.3.0" })).toContain('rolldown pin "1.3.0" is outside "~1.2.14"');
});

test("a rolldown range semver cannot read is refused by name", () => {
  expect(viteRolldownFault({ ...LATEST, rolldownRange: "github:rolldown/rolldown", pin: "1.2.16" })).toBe(
    'Package "@pagedeck/core": vite 8.3.5 declares rolldown "github:rolldown/rolldown", which is not a semver range, so the pack harness cannot tell whether the pin "1.2.16" is inside it — revisit core\'s rolldown pin against that vite (docs/maintaining/packaging.md, "The published tarball")',
  );
});

test("a vite that declares no rolldown dependency is refused by name", () => {
  expect(viteRolldownFault({ ...LATEST, rolldownRange: undefined, pin: "1.2.16" })).toBe(
    'Package "@pagedeck/core": vite 8.3.5, the newest vite its range "^8.3.3" admits, declares no rolldown dependency, so the pin "1.2.16" covers no bundler vite runs — revisit core\'s rolldown pin against that vite (docs/maintaining/packaging.md, "The published tarball")',
  );
});

test("a rolldown pin that is not one exact version is refused by name", () => {
  expect(viteRolldownFault({ ...LATEST, pin: "^1.2.16" })).toBe(
    'Package "@pagedeck/core": its rolldown pin "^1.2.16" is not one exact version, so a fresh install may resolve a rolldown the pin was never checked against — set "rolldown" in packages/core/package.json to one version inside "~1.2.14", the rolldown range of vite 8.3.5 (docs/maintaining/packaging.md, "The published tarball")',
  );
});

test("the newest vite is the semver maximum the range admits, whatever order the registry lists them in", () => {
  expect(newestVite("^8.3.3", ["8.3.4", "8.4.0", "8.3.6", "9.0.0", "8.5.0-beta.1"])).toBe("8.4.0");
  expect(newestVite("^8.3.3", ["8.2.0"])).toBeUndefined();
});
