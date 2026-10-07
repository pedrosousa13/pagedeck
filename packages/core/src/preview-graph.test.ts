import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import { checkPreviewGraph } from "./preview-graph.js";

const HERO = {
  fileName: "assets/Hero-BAPkP0_w.js",
  moduleIds: ["/site/src/Hero.js"],
};

test("a graph reaching no builtin passes", () => {
  expect(() =>
    checkPreviewGraph([
      { fileName: "assets/preview-A830.js", moduleIds: ["\0fw:preview/app"] },
      HERO,
    ]),
  ).not.toThrow();
});

test("a chunk holding a shimmed builtin is refused", () => {
  let thrown: unknown;
  try {
    checkPreviewGraph([
      {
        fileName: "assets/Stamp-CU10.js",
        moduleIds: [
          "\0rolldown/runtime.js",
          "__vite-browser-external:node:crypto",
          "/site/src/Stamp.js",
        ],
      },
    ]);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    'Preview target: 1 chunk reaches a node builtin, which a browser does not have — the preview app bundles every registered component (spec §14), so import the render core from "@pagedeck/core/tree" rather than "@pagedeck/core", and leave node-only work to the loader:\n' +
      '  "assets/Stamp-CU10.js" — node:crypto, from "/site/src/Stamp.js"',
  );
});

test("a raw node specifier left external is refused too", () => {
  expect(() =>
    checkPreviewGraph([
      { fileName: "assets/Stamp-CU10.js", moduleIds: ["node:fs", "/s/S.js"] },
    ]),
  ).toThrow(/node:fs/);
});

test("every offending chunk is reported once", () => {
  let message = "";
  try {
    checkPreviewGraph([
      HERO,
      {
        fileName: "assets/Stamp-CU10.js",
        moduleIds: [
          "__vite-browser-external:node:crypto",
          "__vite-browser-external:node:fs",
          "/site/src/Stamp.js",
        ],
      },
      {
        fileName: "assets/Feed-99Ab.js",
        moduleIds: [
          "/site/src/Feed.js",
          "__vite-browser-external:node:sqlite",
          "/site/src/store.js",
        ],
      },
    ]);
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toContain("2 chunks reach a node builtin");
  expect(message).toContain(
    '  "assets/Feed-99Ab.js" — node:sqlite, from "/site/src/Feed.js", "/site/src/store.js"',
  );
  expect(message).toContain(
    '  "assets/Stamp-CU10.js" — node:crypto, node:fs, from "/site/src/Stamp.js"',
  );
  expect(message).not.toContain("Hero");
});
