import { expect, test } from "vitest";
import { rolldownVersionsFault, viteRolldownFault } from "./pack-install.test-support.js";

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
    'Install "/tmp/site": holds 2 rolldown versions, so the rolldown @pagedeck/core pins is not the one vite bundles with — move "rolldown" in packages/core/package.json to a version inside the rolldown range of the vite core\'s range resolves to (AGENTS.md, "The published tarball"):\n' +
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
    'Package "@pagedeck/core": its rolldown pin "1.2.13" is outside "~1.2.14", the rolldown range of vite 8.3.5, the newest vite its range "^8.3.3" admits, so a fresh install holds two rolldowns — move "rolldown" in packages/core/package.json to a version "~1.2.14" admits (AGENTS.md, "The published tarball")',
  );
  expect(viteRolldownFault({ ...LATEST, pin: "1.3.0" })).toContain('rolldown pin "1.3.0" is outside "~1.2.14"');
});

test("a rolldown range of a form the check cannot read is refused by name", () => {
  expect(viteRolldownFault({ ...LATEST, rolldownRange: "1.2.x", pin: "1.2.16" })).toBe(
    'Package "@pagedeck/core": vite 8.3.5 declares rolldown "1.2.x", a range the pack harness cannot read, so it cannot tell whether the pin "1.2.16" is inside it — teach rangeAdmits in packages/core/src/pack-install.test-support.ts the form',
  );
});
