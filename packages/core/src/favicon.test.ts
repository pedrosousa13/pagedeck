import { expect, test } from "vitest";
import { faviconFaultReport, faviconFiles } from "./favicon.js";
import type { LocaleSet } from "./locales.js";
import type { EmittedFile } from "./manifest.js";

const SETTING = { src: "./favicon.ico" };

const BYTES = new Uint8Array([0, 0, 1, 0]);

function localeSet(...domains: readonly (string | undefined)[]): LocaleSet {
  return new Map(
    domains.map((domain, index) => {
      const code = `l${String(index)}`;
      return [
        code,
        {
          code,
          label: code,
          direction: "ltr" as const,
          prefix: "",
          ...(domain === undefined ? {} : { domain }),
        },
      ];
    }),
  );
}

const DEFAULT_TREE = localeSet(undefined);

function keys(files: readonly EmittedFile[]): readonly string[] {
  return files.map((file) =>
    file.domain === undefined ? file.path : `//${file.domain}${file.path}`,
  );
}

test("a favicon setting that is not an object is refused with the shape as the fix", () => {
  expect(faviconFaultReport(true, "Config")).toBe(
    'Config: "build.favicon" must be an object naming the icon file the site supplies — favicon: { src: "./favicon.ico" }',
  );
});

test("a valid setting reports nothing, and nothing about an origin is asked", () => {
  expect(faviconFaultReport(SETTING, "Config")).toBe(undefined);
});

test("a src that is not a string is refused, naming the field and the fix", () => {
  expect(faviconFaultReport({ src: 3 }, "Config")).toBe(
    'Config: "build.favicon" declares 1 field this build cannot write an icon from — declare each as the type its own line names:\n  "src" — 3 — not a path to the site\'s icon file — point src at the file this build writes at /favicon.ico, such as src: "./favicon.ico"',
  );
});

test("an empty src is refused, because a path to nothing is not a declaration", () => {
  expect(faviconFaultReport({ src: "" }, "Config")).toContain('"src" — ""');
});

test("an inherited src is not a declaration", () => {
  expect(
    faviconFaultReport(Object.create({ src: "./favicon.ico" }), "Config"),
  ).toContain('"src" — undefined');
});

test("the icon is written at /favicon.ico, with the site's own bytes", () => {
  const files = faviconFiles({
    bytes: BYTES,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(keys(files)).toEqual(["/favicon.ico"]);
  expect(files[0]?.kind).toBe("asset");
  expect(files[0]?.contents).toBe(BYTES);
});

test("every output tree gets its own copy, because a browser asks the host that served the page", () => {
  const files = faviconFiles({
    bytes: BYTES,
    locales: localeSet("example.de", undefined, "example.com", "example.de"),
    emitted: [],
  });

  expect(keys(files)).toEqual([
    "/favicon.ico",
    "//example.com/favicon.ico",
    "//example.de/favicon.ico",
  ]);
});

test("an icon at a deploy key this build already wrote is refused, naming every colliding key", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/favicon.ico", kind: "html", contents: "" },
    { domain: "example.de", path: "/favicon.ico", kind: "js", contents: "" },
  ];

  expect(() =>
    faviconFiles({
      bytes: BYTES,
      locales: localeSet(undefined, "example.de"),
      emitted,
    }),
  ).toThrow(
    'Favicon: 2 icons are at a deploy key this build already wrote — a deploy key holds one file, and the site\'s own pages, chunks and assets are written before the icon is; move the page off that address:\n  "//example.de/favicon.ico" — the build already emitted a js file there\n  "/favicon.ico" — the build already emitted an html file there',
  );
});
