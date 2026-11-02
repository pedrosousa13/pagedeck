import { expect, test } from "vitest";
import { rolldownVersionsFault } from "./pack-install.test-support.js";

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
