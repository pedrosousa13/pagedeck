import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const MARKDOWN = join(CORE, "..", "..", "markdown-loader", "src", "index.ts");

const PLAIN_SITE = join(SITES, ".pagedeck-passthrough-plain-test");
const FILES_SITE = join(SITES, ".pagedeck-passthrough-files-test");
const TREES_SITE = join(SITES, ".pagedeck-passthrough-trees-test");
const LINKED_SITE = join(SITES, ".pagedeck-passthrough-linked-test");
const UNLINKED_SITE = join(SITES, ".pagedeck-passthrough-unlinked-test");
const COLLIDE_SITE = join(SITES, ".pagedeck-passthrough-collide-test");
const TWICE_SITE = join(SITES, ".pagedeck-passthrough-twice-test");
const MISSING_SITE = join(SITES, ".pagedeck-passthrough-missing-test");
const NOT_A_DIRECTORY_SITE = join(SITES, ".pagedeck-passthrough-notdir-test");
const POSTS_SITE = join(SITES, ".pagedeck-passthrough-posts-test");
const BROKEN_SITE = join(SITES, ".pagedeck-passthrough-broken-test");
const UNTOUCHED_SITE = join(SITES, ".pagedeck-passthrough-untouched-test");
const UNDECLARED_SITE = join(SITES, ".pagedeck-passthrough-undeclared-test");
const POSTS_TWICE_SITE = join(SITES, ".pagedeck-passthrough-posts-twice-test");
const NO_CONTENT_ROOT_SITE = join(SITES, ".pagedeck-passthrough-nocontent-test");
const POSTS_TREES_SITE = join(SITES, ".pagedeck-passthrough-posts-trees-test");
const MARKDOWN_SITE = join(SITES, ".pagedeck-passthrough-markdown-test");
const UNROOTED_SITE = join(SITES, ".pagedeck-passthrough-unrooted-test");
const LONE_CONTENT_ROOT_SITE = join(SITES, ".pagedeck-passthrough-lone-content-test");
const CONTENT_ONLY_SITE = join(SITES, ".pagedeck-passthrough-content-only-test");
const UNDEPLOYABLE_SITE = join(SITES, ".pagedeck-passthrough-undeployable-test");

const ONE_TREE = `en: { label: "English", direction: "ltr" },`;
const TWO_TREES = `en: { label: "English", direction: "ltr", domain: "example.com" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },`;

const OWN_FILES: Readonly<Record<string, number>> = {
  "og-image.png": 0x01,
  "favicon.svg": 0x02,
  "assets/dev.svg": 0x03,
  "assets/logo.png": 0x04,
  "assets/logo.svg": 0x05,
  "assets/forrest-gump-quote.webp": 0x06,
};

const LINKED = "/assets/logo.png";

// `import.png` and `rules-dark.png` are in the tree and in no post: a stage publishing
// the walk rather than the references emits eleven and fails.
const POSTS: Readonly<Record<string, readonly string[]>> = {
  ferry: [
    "../../assets/images/ferry/logo.png",
    "../../assets/images/ferry/rules.png",
    "../../assets/images/ferry/popup.png",
    "../../assets/images/ferry/preview.png",
  ],
  "json-bonsai": [
    "../../assets/images/json-bonsai/logo.webp",
    "../../assets/images/json-bonsai/search.png",
    "../../assets/images/json-bonsai/query.png",
    "../../assets/images/json-bonsai/schema.png",
    "../../assets/images/json-bonsai/formatted.png",
  ],
};

const CONTENT_IMAGES: Readonly<Record<string, number>> = {
  "assets/images/ferry/logo.png": 0x11,
  "assets/images/ferry/rules.png": 0x12,
  "assets/images/ferry/popup.png": 0x13,
  "assets/images/ferry/preview.png": 0x14,
  "assets/images/ferry/import.png": 0x15,
  "assets/images/ferry/rules-dark.png": 0x16,
  "assets/images/json-bonsai/logo.webp": 0x17,
  "assets/images/json-bonsai/search.png": 0x18,
  "assets/images/json-bonsai/query.png": 0x19,
  "assets/images/json-bonsai/schema.png": 0x1a,
  "assets/images/json-bonsai/formatted.png": 0x1b,
};

const PUBLISHED = Object.values(POSTS)
  .flat()
  .map((href) => href.replace("../../", "/"))
  .sort();

const UNREFERENCED = ["/assets/images/ferry/import.png", "/assets/images/ferry/rules-dark.png"];

const COPY = `import { createElement } from "react";
export default function Copy({ image, images }) {
  return createElement(
    "p",
    null,
    "marker-copy-439",
    image === null ? null : createElement("img", { src: image, alt: "logo" }),
    ...images.map((src, at) =>
      createElement("img", { key: String(at), src, alt: "figure" }),
    ),
  );
}
`;

interface Fixture {
  readonly declared?: string;
  readonly locales?: string;
  readonly contentLocales?: readonly string[];
  readonly files?: Readonly<Record<string, number>>;
  readonly image?: string;
  readonly posts?: Readonly<Record<string, readonly string[]>>;
  readonly contentFiles?: Readonly<Record<string, number>>;
}

const DECLARED = `passthrough: { root: "./public" },`;
const DECLARED_CONTENT = `passthrough: { root: "./public", contentRoot: "./src" },`;
const NO_CONTENT_ROOT =
  "because this site declares no build.passthrough.contentRoot";

function site(root: string, fixture: Fixture = {}): string {
  const {
    declared = "",
    locales = ONE_TREE,
    contentLocales = ["en"],
    files = {},
    image = null,
    posts: postEntries,
    contentFiles = {},
  } = fixture;
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COPY);
  for (const [path, mark] of Object.entries(files)) {
    const file = join(root, "public", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Uint8Array.from([mark]));
  }
  for (const [path, mark] of Object.entries(contentFiles)) {
    const file = join(root, "src", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Uint8Array.from([mark]));
  }
  for (const locale of contentLocales) {
    const entries: Readonly<Record<string, unknown>> =
      postEntries === undefined
        ? { home: { image, images: [] } }
        : Object.fromEntries(
            Object.entries(postEntries).map(([name, images]) => [
              `posts/${name}`,
              { image: null, images },
            ]),
          );
    for (const [path, data] of Object.entries(entries)) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
    }
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const posts = {
  name: "posts",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [posts],
  build: {
    outDir: "./dist",
    ${declared}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        ${locales}
      }),
      sources: [fromCollection(posts${postEntries === undefined ? ', { route: () => "/" }' : ""})],
    }),
    components: {
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: (page, store) => {
      const entry = store.getEntry("posts", page.locale, page.entry.path);
      return {
        tree: [
          {
            component: "Copy",
            props: { image: entry.data.image, images: entry.data.images },
          },
        ],
      };
    },
  },
});
`,
  );
  return root;
}

const POST = `# Ferry

![Ferry logo](../../assets/images/ferry/logo.png)
`;

function markdownSite(root: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(
    join(root, "components", "Body.js"),
    `import { createElement } from "react";
export default function Body({ html }) {
  return createElement("div", { dangerouslySetInnerHTML: { __html: html } });
}
`,
  );
  const post = join(root, "src", "content", "posts", "ferry.md");
  mkdirSync(dirname(post), { recursive: true });
  writeFileSync(post, POST);
  const image = join(root, "src", "assets", "images", "ferry", "logo.png");
  mkdirSync(dirname(image), { recursive: true });
  writeFileSync(image, Uint8Array.from([0x11]));

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { defineMarkdownLoader } from ${JSON.stringify(MARKDOWN)};

const posts = {
  name: "posts",
  loader: defineMarkdownLoader({
    root: ${JSON.stringify(join(root, "src", "content"))},
    locale: "en",
    languages: [],
  }),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [posts],
  build: {
    outDir: "./dist",
    passthrough: { contentRoot: "./src", root: "./public" },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        ${ONE_TREE}
      }),
      sources: [fromCollection(posts)],
    }),
    components: {
      Body: "./components/Body.js",
    },
    tierPolicy: { minSize: 0 },
    content: (page, store) => {
      const entry = store.getEntry("posts", page.locale, page.entry.path);
      return {
        tree: [{ component: "Body", props: { html: entry.data.html } }],
      };
    },
  },
});
`,
  );
  return root;
}

async function runCode(
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; err: string }> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  return { code, err: err.join("\n") };
}

async function run(cwd: string, ...argv: string[]): Promise<number> {
  const { code, err } = await runCode(cwd, ...argv);
  if (code !== EXIT_CODES.success) throw new Error(err);
  return code;
}

interface Built {
  readonly dist: string;
  readonly manifest: Manifest;
  readonly err: string;
}

const built = new Map<string, Promise<Built>>();

function build(root: string, fixture: Fixture = {}): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, fixture);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(root: string, fixture: Fixture): Promise<Built> {
  const dir = site(root, fixture);
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");
  if (code !== EXIT_CODES.success) throw new Error(err);
  return { ...read(join(dir, "dist")), err };
}

function read(dist: string): Omit<Built, "err"> {
  const file = join(dist, "manifest.json");
  return { dist, manifest: readManifest(readFileSync(file, "utf8"), file) };
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    FILES_SITE,
    TREES_SITE,
    LINKED_SITE,
    UNLINKED_SITE,
    COLLIDE_SITE,
    TWICE_SITE,
    MISSING_SITE,
    NOT_A_DIRECTORY_SITE,
    POSTS_SITE,
    BROKEN_SITE,
    UNTOUCHED_SITE,
    UNDECLARED_SITE,
    POSTS_TWICE_SITE,
    NO_CONTENT_ROOT_SITE,
    POSTS_TREES_SITE,
    MARKDOWN_SITE,
    UNROOTED_SITE,
    CONTENT_ONLY_SITE,
    UNDEPLOYABLE_SITE,
    LONE_CONTENT_ROOT_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the site's own files emit at the addresses it chose, with nested paths preserved", async () => {
  const own = await build(FILES_SITE, {
    declared: DECLARED,
    files: OWN_FILES,
  });

  for (const [path, mark] of Object.entries(OWN_FILES)) {
    expect(Uint8Array.from(readFileSync(join(own.dist, path)))).toEqual(
      Uint8Array.from([mark]),
    );
  }
  expect(
    own.manifest.files
      .filter((one) => one.kind === "asset")
      .map((one) => one.path)
      .sort(),
  ).toEqual([
    "/assets/dev.svg",
    "/assets/forrest-gump-quote.webp",
    "/assets/logo.png",
    "/assets/logo.svg",
    "/favicon.svg",
    "/og-image.png",
  ]);
}, 120_000);

test("a declared directory adds the site's own files and moves no page", async () => {
  const plain = await build(PLAIN_SITE);
  const own = await build(FILES_SITE, { declared: DECLARED, files: OWN_FILES });

  const moved = diffOutputTrees(plain.dist, own.dist);
  expect(
    moved
      .filter((one) => one.difference === "second-only")
      .map((one) => one.path),
  ).toEqual([
    "assets/dev.svg",
    "assets/forrest-gump-quote.webp",
    "assets/logo.png",
    "assets/logo.svg",
    "favicon.svg",
    "og-image.png",
  ]);
  expect(moved.filter((one) => one.difference === "first-only")).toEqual([]);
  expect(
    moved.filter((one) => one.difference === "bytes").map((one) => one.path),
  ).toEqual(["manifest.json"]);
}, 120_000);

test("every output tree gets a copy, because a root-relative reference reaches the host that served the page", async () => {
  const own = await build(TREES_SITE, {
    declared: DECLARED,
    locales: TWO_TREES,
    contentLocales: ["en", "de"],
    files: { "assets/logo.png": 0x04 },
  });

  expect(
    Uint8Array.from(
      readFileSync(join(own.dist, "example.com", "assets", "logo.png")),
    ),
  ).toEqual(Uint8Array.from([0x04]));
  expect(
    Uint8Array.from(
      readFileSync(join(own.dist, "example.de", "assets", "logo.png")),
    ),
  ).toEqual(Uint8Array.from([0x04]));
  expect(existsSync(join(own.dist, "assets", "logo.png"))).toBe(false);
}, 120_000);

test("a reference to a published file resolves, and the same reference without the directory fails the build", async () => {
  const linked = await build(LINKED_SITE, {
    declared: DECLARED,
    files: { "assets/logo.png": 0x04 },
    image: LINKED,
  });

  expect(readFileSync(join(linked.dist, "index.html"), "utf8")).toContain(
    `src="${LINKED}"`,
  );
  expect(existsSync(join(linked.dist, "assets", "logo.png"))).toBe(true);

  const dir = site(UNLINKED_SITE, { image: LINKED });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    "Site build: 1 reference names nothing this build emitted",
  );
  expect(err).toMatch(/^ {2}en \/ — "\/assets\/logo\.png"$/m);
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 240_000);

test("a published file at an address a page already claimed refuses the build, naming both", async () => {
  const dir = site(COLLIDE_SITE, {
    declared: DECLARED,
    files: { "index.html": 0x07 },
  });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    "Passthrough: 1 file is at a deploy key this build already wrote",
  );
  expect(err).toContain(
    '"/index.html" — the build already emitted an html file there',
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

// Neither name can be written on Windows.
test.skipIf(process.platform === "win32")(
  "a published file whose name no deploy key can hold refuses the build, naming every such file and its source (#674)",
  async () => {
    const dir = site(UNDEPLOYABLE_SITE, {
      declared: DECLARED,
      files: { "Icon\r": 0x08, "a\\b.txt": 0x09, "favicon.svg": 0x02 },
    });
    await run(dir, "sync");
    const { code, err } = await runCode(dir, "build");

    expect(code).toBe(EXIT_CODES.configError);
    expect(err).toContain(
      [
        'Site build: 2 files are at a key a deploy refuses — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character; rename or delete each:',
        `  "/Icon\\r" — from "${dir}/public/Icon\\r"`,
        `  "/a\\\\b.txt" — from "${dir}/public/a\\\\b.txt"`,
      ].join("\n"),
    );
    expect(err).not.toContain("\r");
    expect(existsSync(join(dir, "dist"))).toBe(false);
  },
  120_000,
);

test("building twice writes the same tree, because a walk's order never reaches the output", async () => {
  const dir = site(TWICE_SITE, { declared: DECLARED, files: OWN_FILES });
  await run(dir, "sync");
  await run(dir, "build");
  const first = join(dir, "trees-1");
  renameSync(join(dir, "dist"), first);
  await run(dir, "build");

  expect(diffOutputTrees(first, join(dir, "dist"))).toEqual([]);
}, 240_000);

test("a root with nothing at it refuses the build, naming the config and the path", async () => {
  const dir = site(MISSING_SITE, {
    declared: `passthrough: { root: "./nowhere" },`,
  });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    '"build.passthrough.root" names a directory that does not exist',
  );
  expect(err).toContain(JSON.stringify(join(dir, "nowhere")));
  expect(err).toContain(
    "point root at the directory of files the site publishes, or remove passthrough",
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a root that is a file refuses the build, rather than failing inside a directory read", async () => {
  const dir = site(NOT_A_DIRECTORY_SITE, {
    declared: `passthrough: { root: "./public/favicon.svg" },`,
    files: { "favicon.svg": 0x02 },
  });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    '"build.passthrough.root" names a path that is not a directory',
  );
  expect(err).toContain(JSON.stringify(join(dir, "public", "favicon.svg")));
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("the nine references two posts make resolve, and only those nine images emit", async () => {
  const own = await build(POSTS_SITE, {
    declared: DECLARED_CONTENT,
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
    contentFiles: CONTENT_IMAGES,
  });

  for (const address of PUBLISHED) {
    const path = address.slice(1);
    expect(
      Uint8Array.from(readFileSync(join(own.dist, ...path.split("/")))),
      address,
    ).toEqual(Uint8Array.from([CONTENT_IMAGES[path] as number]));
  }
  for (const address of UNREFERENCED) {
    expect(existsSync(join(own.dist, ...address.slice(1).split("/"))), address).toBe(
      false,
    );
  }
  expect(
    own.manifest.files
      .filter((one) => one.kind === "asset")
      .map((one) => one.path)
      .sort(),
  ).toEqual([...PUBLISHED, LINKED].sort());
  expect(own.err).not.toContain(NO_CONTENT_ROOT);
}, 240_000);

test("a content tree declared without a root publishes the nine images and none of public/", async () => {
  const own = await build(CONTENT_ONLY_SITE, {
    declared: `passthrough: { contentRoot: "./src" },`,
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
    contentFiles: CONTENT_IMAGES,
  });

  for (const address of PUBLISHED) {
    const path = address.slice(1);
    expect(
      Uint8Array.from(readFileSync(join(own.dist, ...path.split("/")))),
      address,
    ).toEqual(Uint8Array.from([CONTENT_IMAGES[path] as number]));
  }
  expect(
    own.manifest.files
      .filter((one) => one.kind === "asset")
      .map((one) => one.path)
      .sort(),
  ).toEqual([...PUBLISHED].sort());
  expect(existsSync(join(own.dist, "assets", "logo.png"))).toBe(false);
  expect(own.err).not.toContain(NO_CONTENT_ROOT);
}, 240_000);

test("every src an emitted page carries reaches an address this build serves", async () => {
  const own = await build(POSTS_SITE, {
    declared: DECLARED_CONTENT,
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
    contentFiles: CONTENT_IMAGES,
  });
  const emitted = new Set(own.manifest.files.map((one) => one.path));

  let checked = 0;
  for (const page of own.manifest.pages) {
    const html = readFileSync(
      join(own.dist, ...page.output.split("/"), "index.html"),
      "utf8",
    );
    const base = `${page.path.slice(0, page.path.lastIndexOf("/") + 1)}`;
    for (const [, src] of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)) {
      const segments = base.split("/").filter((segment) => segment !== "");
      for (const segment of (src as string).split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      expect(emitted, `${page.path} — ${String(src)}`).toContain(
        `/${segments.join("/")}`,
      );
      checked += 1;
    }
  }
  expect(checked).toBe(PUBLISHED.length);
}, 240_000);

test("a reference naming no file in the content tree refuses the build, naming the page and the reference", async () => {
  const missing = "assets/images/ferry/rules.png";
  const { [missing]: _absent, ...rest } = CONTENT_IMAGES;
  const dir = site(BROKEN_SITE, {
    declared: DECLARED_CONTENT,
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
    contentFiles: rest,
  });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    "Passthrough: 1 reference a page makes to a file beside its content resolves to nothing this build can publish",
  );
  expect(err).toContain(
    'en /posts/ferry — "../../assets/images/ferry/rules.png" → "/assets/images/ferry/rules.png" — content entry "posts en posts/ferry"',
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 240_000);

test("a root-relative reference and an off-origin one build the tree they built before the key existed", async () => {
  const references = ["/assets/logo.png", "https://example.com/off-origin.png"];
  const declared = await build(UNTOUCHED_SITE, {
    declared: DECLARED_CONTENT,
    files: { "assets/logo.png": 0x04 },
    posts: { ferry: references },
    contentFiles: CONTENT_IMAGES,
  });
  const undeclared = await build(UNDECLARED_SITE, {
    declared: DECLARED,
    files: { "assets/logo.png": 0x04 },
    posts: { ferry: references },
    contentFiles: CONTENT_IMAGES,
  });

  expect(
    diffOutputTrees(undeclared.dist, declared.dist).filter(
      (one) => one.path !== "manifest.json",
    ),
  ).toEqual([]);
  const html = readFileSync(
    join(declared.dist, "posts", "ferry", "index.html"),
    "utf8",
  );
  for (const reference of references) expect(html).toContain(`src="${reference}"`);
  expect(undeclared.err).not.toContain(NO_CONTENT_ROOT);
  expect(declared.err).not.toContain(NO_CONTENT_ROOT);
}, 240_000);

test("a site with a content tree builds the same tree twice", async () => {
  const dir = site(POSTS_TWICE_SITE, {
    declared: DECLARED_CONTENT,
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
    contentFiles: CONTENT_IMAGES,
  });
  await run(dir, "sync");
  await run(dir, "build");
  const first = join(dir, "trees-1");
  renameSync(join(dir, "dist"), first);
  await run(dir, "build");

  expect(diffOutputTrees(first, join(dir, "dist"))).toEqual([]);
}, 360_000);

test("a content tree with nothing at it refuses the build, naming the field a reader wrote", async () => {
  const dir = site(NO_CONTENT_ROOT_SITE, {
    declared: `passthrough: { root: "./public", contentRoot: "./nowhere" },`,
    files: { "assets/logo.png": 0x04 },
  });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    '"build.passthrough.contentRoot" names a directory that does not exist',
  );
  expect(err).toContain(JSON.stringify(join(dir, "nowhere")));
  expect(err).toContain(
    "point contentRoot at the content tree a page's content-relative references resolve into, or remove contentRoot",
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a content tree with nothing at it, declared alone, offers removing the setting rather than the key", async () => {
  const dir = site(LONE_CONTENT_ROOT_SITE, {
    declared: `passthrough: { contentRoot: "./nowhere" },`,
  });
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    "point contentRoot at the content tree a page's content-relative references resolve into, or remove passthrough",
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a two-host site gets every referenced file into every tree, and the set is collected once", async () => {
  const own = await build(POSTS_TREES_SITE, {
    declared: DECLARED_CONTENT,
    locales: TWO_TREES,
    contentLocales: ["en", "de"],
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
    contentFiles: CONTENT_IMAGES,
  });

  for (const tree of ["example.com", "example.de"]) {
    for (const address of PUBLISHED) {
      const path = address.slice(1);
      expect(
        Uint8Array.from(readFileSync(join(own.dist, tree, ...path.split("/")))),
        `${tree}${address}`,
      ).toEqual(Uint8Array.from([CONTENT_IMAGES[path] as number]));
    }
  }
  expect(existsSync(join(own.dist, "assets", "images"))).toBe(false);
  expect(
    own.manifest.files
      .filter((one) => one.kind === "asset")
      .map((one) => `${one.domain ?? ""}${one.path}`)
      .sort(),
  ).toEqual(
    ["example.com", "example.de"]
      .flatMap((tree) => [...PUBLISHED, LINKED].map((one) => `${tree}${one}`))
      .sort(),
  );
}, 360_000);

test("a post rendered by the markdown loader resolves its own image reference", async () => {
  const dir = markdownSite(MARKDOWN_SITE);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");

  expect(
    Uint8Array.from(
      readFileSync(join(dist, "assets", "images", "ferry", "logo.png")),
    ),
  ).toEqual(Uint8Array.from([0x11]));
  const html = readFileSync(join(dist, "posts", "ferry", "index.html"), "utf8");
  expect(html).toContain('src="../../assets/images/ferry/logo.png"');
  const emitted = new Set(read(dist).manifest.files.map((one) => one.path));
  expect(emitted).toContain("/assets/images/ferry/logo.png");
  expect(existsSync(join(dist, "content", "posts", "ferry.md"))).toBe(false);
}, 360_000);

test("a site with no content tree builds its relative references and warns once, naming each page, entry and reference", async () => {
  const dir = site(UNROOTED_SITE, {
    declared: DECLARED,
    files: { "assets/logo.png": 0x04 },
    posts: POSTS,
  });
  await run(dir, "sync");
  const first = await runCode(dir, "build");
  expect(first.code, first.err).toBe(EXIT_CODES.success);
  const firstTree = join(dir, "trees-1");
  renameSync(join(dir, "dist"), firstTree);
  const second = await runCode(dir, "build");
  expect(second.code, second.err).toBe(EXIT_CODES.success);

  const headline = `Passthrough: 9 content-relative references resolve to nothing this build publishes, ${NO_CONTENT_ROOT}`;
  expect(first.err.split(headline)).toHaveLength(2);
  expect(first.err).toContain(
    '  en /posts/ferry — "../../assets/images/ferry/logo.png" → "/assets/images/ferry/logo.png" — content entry "posts en posts/ferry"',
  );
  expect(first.err).toContain(
    '  en /posts/json-bonsai — "../../assets/images/json-bonsai/query.png" → "/assets/images/json-bonsai/query.png" — content entry "posts en posts/json-bonsai"',
  );
  expect(first.err).toContain("declare build.passthrough.contentRoot");
  const warning = (err: string): string =>
    err.slice(err.indexOf(headline)).split("\n").slice(0, 10).join("\n");
  expect(warning(second.err)).toBe(warning(first.err));
  expect(diffOutputTrees(firstTree, join(dir, "dist"))).toEqual([]);
}, 360_000);
