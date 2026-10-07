import { expect, test } from "vitest";
import type { LocaleSet } from "./locales.js";
import type { EmittedFile } from "./manifest.js";
import {
  previewDocument,
  previewFaultReport,
  previewFiles,
  previewPath,
} from "./preview.js";
import type { PreviewBundle } from "./preview.js";

const SETTING = { path: "/_preview" };

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

const BUNDLE: PreviewBundle = {
  entry: "assets/preview-9f1c2ab3.js",
  files: [
    {
      fileName: "assets/preview-9f1c2ab3.js",
      kind: "js",
      contents: "mountPreview({});\n",
    },
    { fileName: "assets/Hero-1d2e.js", kind: "js", contents: "export {};\n" },
  ],
};

function keys(files: readonly EmittedFile[]): readonly string[] {
  return files.map((file) =>
    file.domain === undefined ? file.path : `//${file.domain}${file.path}`,
  );
}

function text(file: EmittedFile | undefined): string {
  return typeof file?.contents === "string" ? file.contents : "";
}

test("a preview setting that is not an object is refused with the shape as the fix", () => {
  expect(previewFaultReport(true, "Config")).toBe(
    'Config: "build.preview" must be an object naming where the preview app is emitted — preview: { path: "/_preview" }',
  );
});

test("a declaration with a path and nothing else reports nothing", () => {
  expect(previewFaultReport(SETTING, "Config")).toBe(undefined);
});

test("a missing path is refused, because the address is the whole declaration", () => {
  expect(previewFaultReport({}, "Config")).toBe(
    'Config: "build.preview" declares 1 field this build cannot emit a preview app from — declare each as the type its own line names:\n  "path" — undefined — not a root-relative path to emit the preview app at — write the address the CMS loads the app from, starting at the root and with no trailing slash, such as path: "/_preview"',
  );
});

test("a path that is not rooted, or ends in a slash, or holds whitespace is refused", () => {
  for (const path of ["_preview", "/_preview/", "/my preview"]) {
    expect(previewFaultReport({ path }, "Config")).toContain(
      `  "path" — ${JSON.stringify(path)} — not a root-relative path`,
    );
  }
});

test("a bridge that is not a module specifier is refused, naming the field", () => {
  expect(previewFaultReport({ ...SETTING, bridge: 42 }, "Config")).toBe(
    'Config: "build.preview" declares 1 field this build cannot emit a preview app from — declare each as the type its own line names:\n  "bridge" — 42 — not a module specifier — point bridge at a module that default-exports a PreviewBridge, such as bridge: "./src/preview-bridge.ts"',
  );
});

test("both faults are reported in one run, so a reader edits once", () => {
  const report = previewFaultReport({ path: "", bridge: "" }, "Config");
  expect(report).toContain('declares 2 fields this build cannot emit');
  expect(report).toContain('  "path" — ""');
  expect(report).toContain('  "bridge" — ""');
});

test("the app is emitted under the declared path, document first", () => {
  const files = previewFiles({
    setting: SETTING,
    bundle: BUNDLE,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(keys(files)).toEqual([
    "/_preview/index.html",
    "/_preview/assets/preview-9f1c2ab3.js",
    "/_preview/assets/Hero-1d2e.js",
  ]);
  expect(files.map((file) => file.kind)).toEqual(["html", "js", "js"]);
});

test("the emitted document loads the entry chunk by a root-relative URL", () => {
  const files = previewFiles({
    setting: SETTING,
    bundle: BUNDLE,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(text(files[0])).toBe(
    previewDocument("/_preview/assets/preview-9f1c2ab3.js"),
  );
  expect(text(files[0])).toContain(
    '<script type="module" src="/_preview/assets/preview-9f1c2ab3.js"></script>',
  );
  expect(text(files[0])).toContain('<div id="fw-preview"></div>');
  expect(text(files[0])).toContain('<meta name="robots" content="noindex">');
});

test("every output tree gets the whole app, the default tree first", () => {
  const files = previewFiles({
    setting: SETTING,
    bundle: BUNDLE,
    locales: localeSet("example.de", undefined, "example.com"),
    emitted: [],
  });

  expect(keys(files)).toEqual([
    "/_preview/index.html",
    "/_preview/assets/preview-9f1c2ab3.js",
    "/_preview/assets/Hero-1d2e.js",
    "//example.com/_preview/index.html",
    "//example.com/_preview/assets/preview-9f1c2ab3.js",
    "//example.com/_preview/assets/Hero-1d2e.js",
    "//example.de/_preview/index.html",
    "//example.de/_preview/assets/preview-9f1c2ab3.js",
    "//example.de/_preview/assets/Hero-1d2e.js",
  ]);
});

test("a page already at the app's address is refused, naming every colliding key", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/_preview/index.html", kind: "html", contents: "" },
    {
      domain: "example.de",
      path: "/_preview/assets/Hero-1d2e.js",
      kind: "js",
      contents: "",
    },
  ];

  expect(() =>
    previewFiles({
      setting: SETTING,
      bundle: BUNDLE,
      locales: localeSet(undefined, "example.de"),
      emitted,
    }),
  ).toThrow(
    'Preview: 2 files are at a deploy key this build already wrote — a deploy key holds one file, and the site\'s own pages, chunks and assets are written before the preview app is; move the page off that address, or declare a "build.preview.path" the site does not publish under:\n  "//example.de/_preview/assets/Hero-1d2e.js" — the build already emitted a js file there\n  "/_preview/index.html" — the build already emitted an html file there',
  );
});

test("previewPath is the one spelling of an address under the declared path", () => {
  expect(previewPath("/_preview", "index.html")).toBe("/_preview/index.html");
  expect(previewPath("/_preview", "assets/a.js")).toBe(
    "/_preview/assets/a.js",
  );
});
