import { expect, test } from "vitest";
import type { LocaleSet } from "./locales.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";
import {
  contentRelativeReferences,
  passthroughFaultReport,
  passthroughFiles,
} from "./passthrough.js";

const SETTING = { root: "./public" };

const ROOT = "/site/public";

function bytes(mark: number): Uint8Array {
  return new Uint8Array([mark]);
}

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

test("a passthrough setting that is not an object is refused with the shape as the fix", () => {
  expect(passthroughFaultReport(true, "Config")).toBe(
    'Config: "build.passthrough" must be an object naming the directory of files the site publishes whole, the content tree its pages\' relative references resolve into, or both — passthrough: { root: "./public" }, or passthrough: { contentRoot: "./src" }',
  );
});

test("a valid setting reports nothing, and nothing about an origin is asked", () => {
  expect(passthroughFaultReport(SETTING, "Config")).toBe(undefined);
});

test("a root that is not a string is refused, naming the field and the fix", () => {
  expect(passthroughFaultReport({ root: 3 }, "Config")).toBe(
    'Config: "build.passthrough" declares 1 field this build cannot publish the site\'s own files from — declare each as the type its own line names:\n  "root" — 3 — not a path to the directory of files the site publishes — point root at the directory whose files this build publishes, such as root: "./public"',
  );
});

test("an empty root is refused beside a non-string, because it resolves to the site itself", () => {
  expect(passthroughFaultReport({ root: "" }, "Config")).toContain(
    '"root" — ""',
  );
});

test("a root off a prototype is not read as a directory the site wrote", () => {
  expect(
    passthroughFaultReport(Object.create({ root: 3 }), "Config"),
  ).toContain("declares neither root nor contentRoot");
});

test("a setting that declares neither key is refused, because it publishes nothing", () => {
  const refusal =
    'Config: "build.passthrough" declares neither root nor contentRoot, so it publishes nothing — declare root as the directory of files the site publishes whole, such as root: "./public", declare contentRoot as the content tree its pages\' relative references resolve into, such as contentRoot: "./src", or remove passthrough';
  expect(passthroughFaultReport({}, "Config")).toBe(refusal);
  expect(
    passthroughFaultReport({ root: undefined, contentRoot: undefined }, "Config"),
  ).toBe(refusal);
});

test("a contentRoot declared alone is a valid setting, and so is an explicit undefined root", () => {
  expect(passthroughFaultReport({ contentRoot: "./src" }, "Config")).toBe(
    undefined,
  );
  expect(
    passthroughFaultReport({ root: undefined, contentRoot: "./src" }, "Config"),
  ).toBe(undefined);
});

test("each file is emitted at its path beneath the declared root, nesting preserved", () => {
  const files = passthroughFiles({
    field: "root",
    root: ROOT,
    files: [
      { src: `${ROOT}/assets/logo.png`, bytes: bytes(1) },
      { src: `${ROOT}/favicon.svg`, bytes: bytes(2) },
    ],
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(keys(files)).toEqual(["/assets/logo.png", "/favicon.svg"]);
  expect(files.map((one) => one.kind)).toEqual(["asset", "asset"]);
  expect(files[1]?.contents).toEqual(bytes(2));
});

test("the files come out in address order, whatever order the directory was read in", () => {
  const files = passthroughFiles({
    field: "root",
    root: ROOT,
    files: [
      { src: `${ROOT}/b.txt`, bytes: bytes(1) },
      { src: `${ROOT}/assets/z.svg`, bytes: bytes(2) },
      { src: `${ROOT}/a.txt`, bytes: bytes(3) },
    ],
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(keys(files)).toEqual(["/a.txt", "/assets/z.svg", "/b.txt"]);
});

test("every output tree gets a copy, because a root-relative reference resolves in its own tree", () => {
  const files = passthroughFiles({
    field: "root",
    root: ROOT,
    files: [{ src: `${ROOT}/assets/logo.png`, bytes: bytes(1) }],
    locales: localeSet("example.de", undefined, "example.com", "example.de"),
    emitted: [],
  });

  expect(keys(files)).toEqual([
    "/assets/logo.png",
    "//example.com/assets/logo.png",
    "//example.de/assets/logo.png",
  ]);
});

test("a site that declares a root holding no file emits nothing", () => {
  expect(
    passthroughFiles({
      field: "root",
      root: ROOT,
      files: [],
      locales: DEFAULT_TREE,
      emitted: [],
    }),
  ).toEqual([]);
});

test("a passthrough file at a deploy key this build already wrote is refused, naming every colliding key", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/about/index.html", kind: "html", contents: "" },
    { domain: "example.de", path: "/sitemap.xml", kind: "asset", contents: "" },
  ];

  expect(() =>
    passthroughFiles({
      field: "root",
      root: ROOT,
      files: [
        { src: `${ROOT}/about/index.html`, bytes: bytes(1) },
        { src: `${ROOT}/sitemap.xml`, bytes: bytes(2) },
      ],
      locales: localeSet(undefined, "example.de"),
      emitted,
    }),
  ).toThrow(
    'Passthrough: 2 files are at a deploy key this build already wrote — a deploy key holds one file, and the site\'s own pages, chunks and the files this build composes are all written first; move the page off that address, or take the file out of the directory "build.passthrough.root" names:\n  "//example.de/sitemap.xml" — the build already emitted an asset file there\n  "/about/index.html" — the build already emitted an html file there',
  );
});

test("a contentRoot file at a deploy key this build already wrote names contentRoot, the key that collided", () => {
  const CONTENT = "/site/src";

  expect(() =>
    passthroughFiles({
      field: "contentRoot",
      root: CONTENT,
      files: [{ src: `${CONTENT}/about/index.html`, bytes: bytes(1) }],
      locales: localeSet(undefined, "example.de"),
      emitted: [{ path: "/about/index.html", kind: "html", contents: "" }],
    }),
  ).toThrow(
    'Passthrough: 1 file is at a deploy key this build already wrote — a deploy key holds one file, and the site\'s own pages, chunks and the files this build composes are all written first; point the reference that resolves there at another file beneath the directory "build.passthrough.contentRoot" names, one at an address no output tree already holds, or have every output tree emit a file at that address:\n  "/about/index.html" — the build already emitted an html file there',
  );
});

const FERRY: Page = {
  locale: "en",
  path: "/posts/ferry",
  output: "/posts/ferry",
  collection: "posts",
  entry: { locale: "en", path: "ferry" },
  dependencies: [],
};

function document(path: string, html: string): EmittedFile {
  return {
    path,
    kind: "html",
    page: { locale: "en", path: path.replace(/\/index\.html$/, "") || "/" },
    contents: html,
  };
}

test("a contentRoot that is not a string is refused beside root, in one report", () => {
  expect(passthroughFaultReport({ root: 3, contentRoot: 3 }, "Config")).toBe(
    'Config: "build.passthrough" declares 2 fields this build cannot publish the site\'s own files from — declare each as the type its own line names:\n  "root" — 3 — not a path to the directory of files the site publishes — point root at the directory whose files this build publishes, such as root: "./public"\n  "contentRoot" — 3 — not a path to the content tree a page\'s content-relative references resolve into — point contentRoot at the content tree a page\'s content-relative references resolve into, such as contentRoot: "./src"',
  );
});

test("an absent contentRoot is the absence it spells, and an explicit undefined is too", () => {
  expect(passthroughFaultReport(SETTING, "Config")).toBe(undefined);
  expect(
    passthroughFaultReport({ root: "./public", contentRoot: undefined }, "Config"),
  ).toBe(undefined);
});

test("an empty contentRoot is refused, because it resolves to the site itself", () => {
  expect(
    passthroughFaultReport({ root: "./public", contentRoot: "" }, "Config"),
  ).toContain('"contentRoot" — ""');
});

test("a relative reference resolves against the address its page is served at", () => {
  expect(
    contentRelativeReferences({
      documents: [
        document(
          "/posts/ferry/index.html",
          '<p><img src="../../assets/images/ferry/logo.png" alt="Ferry logo"></p>',
        ),
      ],
      emitted: [],
      pages: [FERRY],
      trailingSlash: "never",
    }),
  ).toEqual([
    {
      entry: "posts en ferry",
      page: "en /posts/ferry",
      href: "../../assets/images/ferry/logo.png",
      address: "/assets/images/ferry/logo.png",
    },
  ]);
});

test("a page no stored entry backs names no entry rather than naming a wrong one", () => {
  expect(
    contentRelativeReferences({
      documents: [
        document("/posts/ferry/index.html", '<img src="../../a.png">'),
      ],
      emitted: [],
      pages: [
        {
          locale: "en",
          path: "/posts/ferry",
          output: "/posts/ferry",
          dependencies: [],
        },
      ],
      trailingSlash: "never",
    }),
  ).toEqual([
    { page: "en /posts/ferry", href: "../../a.png", address: "/a.png" },
  ]);
});

test("the same document under the two trailing-slash policies resolves two addresses", () => {
  const documents = [document("/posts/ferry/index.html", '<img src="./logo.png">')];
  expect(
    contentRelativeReferences({
      documents,
      emitted: [],
      pages: [],
      trailingSlash: "never",
    }).map((one) => one.address),
  ).toEqual(["/posts/logo.png"]);
  expect(
    contentRelativeReferences({
      documents,
      emitted: [],
      pages: [],
      trailingSlash: "always",
    }).map((one) => one.address),
  ).toEqual(["/posts/ferry/logo.png"]);
});

test("a reference that walks above the root lands at the root rather than outside it", () => {
  expect(
    contentRelativeReferences({
      documents: [document("/index.html", '<img src="../../../etc/passwd">')],
      emitted: [],
      pages: [],
      trailingSlash: "never",
    }).map((one) => one.address),
  ).toEqual(["/etc/passwd"]);
});

test("a root-relative, an off-origin and a queried reference are all left alone", () => {
  expect(
    contentRelativeReferences({
      documents: [
        document(
          "/posts/ferry/index.html",
          [
            '<img src="/assets/logo.png">',
            '<img src="https://example.com/off.png">',
            '<img src="//example.com/off.png">',
            '<a href="../json-bonsai">next</a>',
            '<img src="../resize.png?w=320">',
          ].join(""),
        ),
      ],
      emitted: [],
      pages: [],
      trailingSlash: "never",
    }),
  ).toEqual([]);
});

test("an address this build already emitted is not collected, so nothing is published twice", () => {
  expect(
    contentRelativeReferences({
      documents: [document("/posts/ferry/index.html", '<img src="../logo.png">')],
      emitted: [{ path: "/logo.png", kind: "asset", contents: bytes(1) }],
      pages: [],
      trailingSlash: "never",
    }),
  ).toEqual([]);
});

test("one address is collected once however many pages point at it, in address order", () => {
  expect(
    contentRelativeReferences({
      documents: [
        document(
          "/posts/ferry/index.html",
          '<img src="../../b.png"><img src="../../a.png">',
        ),
        document("/posts/json-bonsai/index.html", '<img src="../../b.png">'),
      ],
      emitted: [],
      pages: [],
      trailingSlash: "never",
    }).map((one) => one.address),
  ).toEqual(["/a.png", "/b.png"]);
});
