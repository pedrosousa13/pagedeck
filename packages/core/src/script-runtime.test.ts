import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import * as core from "./index.js";
import { defineLocales } from "./locales.js";
import { scriptRuntimeBase, scriptRuntimeOutput } from "./script-runtime.js";

const EN = defineLocales({ en: { label: "English", direction: "ltr" } });

const BOOT = Object.assign(() => ({}), {
  files: [{ name: "boot.js", contents: "self.boot = 1;" }],
});

test("a runtime's files are placed in a directory named by a hash of their names and bytes", () => {
  const files = [
    { name: "boot.js", contents: "self.boot = 1;" },
    { name: "frame.html", contents: new TextEncoder().encode("<!doctype html>") },
  ];
  const expected = createHash("sha256")
    .update(
      JSON.stringify(
        files.map(({ name, contents }) => [
          name,
          createHash("sha256").update(contents).digest("hex"),
        ]),
      ),
    )
    .digest("hex")
    .slice(0, 8);

  expect(scriptRuntimeBase(files)).toBe(`/script-runtime/${expected}/`);
  expect(core.scriptRuntimeBase).toBe(scriptRuntimeBase);
  expect(
    scriptRuntimeOutput({ runtime: Object.assign(() => ({}), { files }), locales: EN, emitted: [] }).map(
      ({ path }) => path,
    ),
  ).toEqual([`/script-runtime/${expected}/boot.js`, `/script-runtime/${expected}/frame.html`]);
});

test("a runtime's files move to a new directory when one byte of them changes", () => {
  expect(scriptRuntimeBase([{ name: "boot.js", contents: "a" }])).not.toBe(
    scriptRuntimeBase([{ name: "boot.js", contents: "b" }]),
  );
});

test("a runtime's files are written into every domain tree, hashed, as assets", () => {
  const base = scriptRuntimeBase(BOOT.files);
  const files = scriptRuntimeOutput({
    runtime: BOOT,
    locales: defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
    }),
    emitted: [],
  });

  expect(files).toEqual([
    { path: `${base}boot.js`, kind: "asset", hashed: true, contents: "self.boot = 1;" },
    {
      domain: "example.de",
      path: `${base}boot.js`,
      kind: "asset",
      hashed: true,
      contents: "self.boot = 1;",
    },
  ]);
});

test("a site with no runtime, or a runtime with no files or an empty list, writes none", () => {
  for (const runtime of [undefined, () => ({}), Object.assign(() => ({}), { files: [] })]) {
    expect(scriptRuntimeOutput({ runtime, locales: EN, emitted: [] })).toEqual([]);
  }
});

test("a runtime file at a key the build already wrote is refused, naming the key", () => {
  const base = scriptRuntimeBase(BOOT.files);

  expect(() =>
    scriptRuntimeOutput({
      runtime: BOOT,
      locales: EN,
      emitted: [{ path: `${base}boot.js`, kind: "html", contents: "" }],
    }),
  ).toThrow(
    `Script runtime: "build.scripts.runtime" declares 1 file at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the runtime's files are; move the page off that address:\n  "${base}boot.js" — "boot.js" — the build already emitted an html file there`,
  );
});
