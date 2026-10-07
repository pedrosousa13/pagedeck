import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENT = `export default function Hero() { return "marker-hero-3f27"; }\n`;

const CARD_COMPONENT = `import { createElement } from "react";
export default function Hero() {
  return createElement(
    "div",
    null,
    createElement("meta", { name: "twitter:card", content: "summary" }),
    "marker-hero-3f27",
  );
}
`;

const PLAIN_SITE = join(SITES, ".pagedeck-social-plain-test");
const DECLARED_SITE = join(SITES, ".pagedeck-social-declared-test");
const REBUILD_SITE = join(SITES, ".pagedeck-social-rebuild-test");
const REFUSING_SITE = join(SITES, ".pagedeck-social-refusing-test");
const CRASHING_SITE = join(SITES, ".pagedeck-social-crashing-test");
const DOUBLE_SITE = join(SITES, ".pagedeck-social-double-test");
const OTHER_BYTES_SITE = join(SITES, ".pagedeck-social-other-bytes-test");
const RIFF_SITE = join(SITES, ".pagedeck-social-riff-test");
const CARRIED_SITE = join(SITES, ".pagedeck-social-carried-test");
const TAMPERED_SITE = join(SITES, ".pagedeck-social-tampered-test");
const CLAIMED_SITE = join(SITES, ".pagedeck-social-claimed-test");
const TREES_SITE = join(SITES, ".pagedeck-social-trees-test");
const CARRIED_TREES_SITE = join(SITES, ".pagedeck-social-carried-trees-test");
const PARTIAL_SITE = join(SITES, ".pagedeck-social-partial-test");
const DROPPED_TREE_SITE = join(SITES, ".pagedeck-social-dropped-tree-test");

const ONE_TREE = `en: { label: "en", direction: "ltr" },`;
const TWO_TREES = `en: { label: "en", direction: "ltr", domain: "example.com" },
        de: { label: "de", direction: "ltr", domain: "example.de" },`;

// The PNG magic bytes are load-bearing: the deploy path's `.png` extension is sniffed
// off them.
const STUB_ADAPTER = `{
      name: "stub-cards",
      draw: (request) => ({
        bytes: new Uint8Array([
          ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          ...new TextEncoder().encode(
            "page=" + request.page.locale + request.page.path +
            ";title=" + String(request.title) +
            ";inputs=" + JSON.stringify(request.inputs),
          ),
        ]),
        width: 1200,
        height: 630,
      }),
    }`;

const DECLARED_CARDS = `socialImages: {
      adapter: ${STUB_ADAPTER},
      inputs: (page) => (page.path === "/" ? { eyebrow: "Docs" } : undefined),
    },
    head: (page) => ({ title: page.path === "/" ? "Home" : "About" }),`;

const REFUSING_CARDS = `socialImages: {
      adapter: {
        name: "stub-cards",
        draw: () => {
          throw new ConfigError(
            'Social image: the "stub-cards" adapter was given no "title" to draw — add title to what "build.socialImages.inputs" returns',
          );
        },
      },
      inputs: () => ({ eyebrow: "Docs" }),
    },`;

const CRASHING_CARDS = `socialImages: {
      adapter: {
        name: "stub-cards",
        draw: () => {
          throw new TypeError("cannot read properties of undefined");
        },
      },
      inputs: () => ({ eyebrow: "Docs" }),
    },`;

// One input word changed: the stub echoes `inputs`, so the two cards differ only in what
// was drawn, not in slug or head.
const OTHER_BYTES_CARDS = `socialImages: {
      adapter: ${STUB_ADAPTER},
      inputs: (page) => (page.path === "/" ? { eyebrow: "Guides" } : undefined),
    },
    head: (page) => ({ title: page.path === "/" ? "Home" : "About" }),`;

const RIFF_CARDS = `socialImages: {
      adapter: {
        name: "stub-cards",
        draw: () => ({
          bytes: new Uint8Array([
            ...new TextEncoder().encode("RIFF"),
            0x24, 0x00, 0x00, 0x00,
            ...new TextEncoder().encode("WAVEfmt "),
          ]),
          width: 1200,
          height: 630,
        }),
      },
      inputs: (page) => (page.path === "/" ? { eyebrow: "Docs" } : undefined),
    },`;

// Every page's title comes off the `about` entry, so editing it moves the home page's
// card while the plan still reuses that page (#281).
const CROSS_PAGE_CARDS = `socialImages: {
      adapter: ${STUB_ADAPTER},
      inputs: () => ({ eyebrow: "Docs" }),
    },
    head: (page, store) => ({
      title: store.getEntry("pages", "en", "about").data.title,
    }),`;

const DOUBLE_CARDS = `socialImages: {
      adapter: ${STUB_ADAPTER},
      inputs: () => ({ eyebrow: "Docs" }),
    },
    head: (page) => ({
      title: "Home",
      image:
        page.path === "/"
          ? "https://cdn.example/hand.png"
          : "https://reader:s3cret@cdn.example/private.png",
    }),`;

const CONTENT: Record<string, string> = {
  home: "Home",
  about: "About",
};

function site(
  root: string,
  build = "",
  component = COMPONENT,
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Hero.js"), component);
  for (const locale of contentLocales) {
    for (const [path, title] of Object.entries(CONTENT)) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
    }
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};
import { ConfigError } from ${JSON.stringify(join(CORE, "exit.ts"))};

const usage = (component) => [
  { component, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: () => "landing",
    byTemplate: { landing: usage("Hero") },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${build}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        ${locales}
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Hero" }] }),
  },
});
`,
  );
  return root;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(cwd: string, ...argv: string[]): Promise<Run> {
  const { runCli } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function ok(cwd: string, ...argv: string[]): Promise<Run> {
  const result = await run(cwd, ...argv);
  if (result.code !== EXIT_CODES.success) throw new Error(result.err);
  return result;
}

const built = new Map<string, Promise<string>>();

function build(
  root: string,
  declaration = "",
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): Promise<string> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, declaration, locales, contentLocales);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  declaration: string,
  locales: string,
  contentLocales: readonly string[],
): Promise<string> {
  const dir = site(root, declaration, COMPONENT, locales, contentLocales);
  await ok(dir, "sync");
  await ok(dir, "build");
  return join(dir, "dist");
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    DECLARED_SITE,
    REBUILD_SITE,
    REFUSING_SITE,
    CRASHING_SITE,
    DOUBLE_SITE,
    OTHER_BYTES_SITE,
    RIFF_SITE,
    CARRIED_SITE,
    TAMPERED_SITE,
    CLAIMED_SITE,
    TREES_SITE,
    CARRIED_TREES_SITE,
    PARTIAL_SITE,
    DROPPED_TREE_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site that declares no social images builds the tree it built without the field", async () => {
  const plain = await build(PLAIN_SITE);
  const declared = await build(DECLARED_SITE, DECLARED_CARDS);
  const again = await build(join(SITES, ".pagedeck-social-plain-again-test"), "");

  expect(diffOutputTrees(plain, again)).toEqual([]);
  expect(
    diffOutputTrees(plain, declared).filter((one) =>
      one.path.startsWith("social/"),
    ),
  ).toEqual([expect.objectContaining({ difference: "second-only" })]);
  rmSync(join(SITES, ".pagedeck-social-plain-again-test"), {
    recursive: true,
    force: true,
  });
}, 180_000);

// Client `js` and `css` are left out: their bytes move with the islands runtime and React.
test("a site that declares no social images emits the bytes it emitted before cards reached components", async () => {
  const dist = await build(PLAIN_SITE);
  const file = join(dist, "manifest.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    files: readonly { path: string; kind: string }[];
  };

  expect(
    raw.files
      .filter((row) => row.kind !== "js" && row.kind !== "css")
      .map((row) => `${row.kind} ${row.path}`),
  ).toEqual(["html /about/index.html", "html /index.html"]);
  const documents = Object.fromEntries(
    ["index.html", "about/index.html"].map((path) => [
      path,
      readFileSync(join(dist, path), "utf8").replace(
        /\/assets\/[^"]+/g,
        "/assets/<chunk>",
      ),
    ]),
  );
  expect(documents).toMatchInlineSnapshot(`
    {
      "about/index.html": "<!doctype html>
    <html lang="en" dir="ltr">
    <head>
    <meta charset="utf-8">
    </head>
    <body>
    <main>
    <fw-island data-fw-prefix="i22ab99d8d33a" data-fw-component="Hero" data-fw-mode="visible" data-fw-props="{}" role="presentation" style="display:contents">marker-hero-3f27</fw-island>
    </main>
    <script type="module" src="/assets/<chunk>"></script>
    </body>
    </html>
    ",
      "index.html": "<!doctype html>
    <html lang="en" dir="ltr">
    <head>
    <meta charset="utf-8">
    </head>
    <body>
    <main>
    <fw-island data-fw-prefix="ie1c71a671410" data-fw-component="Hero" data-fw-mode="visible" data-fw-props="{}" role="presentation" style="display:contents">marker-hero-3f27</fw-island>
    </main>
    <script type="module" src="/assets/<chunk>"></script>
    </body>
    </html>
    ",
    }
  `);
}, 180_000);

test("a declared page's card is written as a content-hashed asset and hashed into the manifest", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_CARDS);

  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(
    readFileSync(manifestFile, "utf8"),
    manifestFile,
  );
  const cards = manifest.files.filter((row) => row.path.startsWith("/social/"));

  expect(cards).toHaveLength(1);
  expect(cards[0]?.kind).toBe("asset");
  expect(cards[0]?.path).toMatch(/^\/social\/en\.[0-9a-f]{8}\.png$/);
  expect(cards[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("two cards drawn for one page from different bytes land at different paths", async () => {
  const declared = await build(DECLARED_SITE, DECLARED_CARDS);
  const other = await build(OTHER_BYTES_SITE, OTHER_BYTES_CARDS);
  const cardPath = (dist: string): string | undefined => {
    const file = join(dist, "manifest.json");
    return readManifest(readFileSync(file, "utf8"), file).files.find((row) =>
      row.path.startsWith("/social/"),
    )?.path;
  };

  expect(cardPath(declared)).toMatch(/^\/social\/en\.[0-9a-f]{8}\.png$/);
  expect(cardPath(other)).toMatch(/^\/social\/en\.[0-9a-f]{8}\.png$/);
  expect(cardPath(other)).not.toBe(cardPath(declared));
}, 180_000);

test("a RIFF container that is not a WebP is not written as one", async () => {
  const dist = await build(RIFF_SITE, RIFF_CARDS);
  const file = join(dist, "manifest.json");
  const cards = readManifest(readFileSync(file, "utf8"), file).files.filter(
    (row) => row.path.startsWith("/social/"),
  );

  expect(cards).toHaveLength(1);
  expect(cards[0]?.path).toMatch(/^\/social\/en\.[0-9a-f]{8}$/);
}, 180_000);

test("the adapter is handed the page, its title and the site's own declared inputs", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_CARDS);

  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(
    readFileSync(manifestFile, "utf8"),
    manifestFile,
  );
  const card = manifest.files.find((row) => row.path.startsWith("/social/"));
  const bytes = readFileSync(join(dist, (card?.path as string).slice(1)));

  expect(bytes.subarray(8).toString("utf8")).toBe(
    'page=en/;title=Home;inputs={"eyebrow":"Docs"}',
  );
});

test("the card's URL, its size and its card kind are written into the page's head", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_CARDS);
  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(
    readFileSync(manifestFile, "utf8"),
    manifestFile,
  );
  const href = manifest.files.find((row) =>
    row.path.startsWith("/social/"),
  )?.path;
  const page = readFileSync(join(dist, "index.html"), "utf8");

  expect(page).toContain(
    [
      `<meta property="og:image" content="${String(href)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].join("\n"),
  );
});

test("a page the site returned no inputs for gets no card and no og:image", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_CARDS);
  const page = readFileSync(join(dist, "about", "index.html"), "utf8");

  expect(page).not.toContain("og:image");
  expect(page).not.toContain("twitter:card");
});

test("two builds of one unchanged site write the card at the identical path", async () => {
  const dir = site(REBUILD_SITE, DECLARED_CARDS);
  await ok(dir, "sync");
  await ok(dir, "build");
  const first = join(dir, "dist", "manifest.json");
  const firstManifest = readManifest(readFileSync(first, "utf8"), first);
  const firstCard = firstManifest.files.find((row) =>
    row.path.startsWith("/social/"),
  );

  await ok(dir, "build");
  const secondManifest = readManifest(readFileSync(first, "utf8"), first);
  const secondCard = secondManifest.files.find((row) =>
    row.path.startsWith("/social/"),
  );

  expect(firstCard?.path).toBeDefined();
  expect(secondCard?.path).toBe(firstCard?.path);
  expect(secondCard?.hash).toBe(firstCard?.hash);
}, 240_000);

test("an adapter that refuses the site's config exits 2, carrying its own refusal", async () => {
  const dir = site(REFUSING_SITE, REFUSING_CARDS);
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain('no "title" to draw');
  expect(result.err).not.toContain("threw while drawing");
}, 180_000);

test("an adapter that crashes exits 1, wrapped in a message naming the adapter and the page", async () => {
  const dir = site(CRASHING_SITE, CRASHING_CARDS);
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).toContain(
    'Social image: the "stub-cards" adapter threw while drawing the card for "en /"',
  );
  expect(result.err).toContain("cannot read properties of undefined");
}, 180_000);

test("every page that is both hand-declared an image and drawn one is refused, in one report", async () => {
  const dir = site(DOUBLE_SITE, DOUBLE_CARDS);
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    '"build.socialImages" draws a card for 2 pages that "build.head" declares an image for too',
  );
  expect(result.err).toContain(
    '  "en /" — "build.head" declared "https://cdn.example/hand.png"',
  );
  expect(result.err).toContain(
    '  "en /about" — "build.head" declared "https://cdn.example/private.png"',
  );
  expect(result.err).not.toContain("s3cret");
}, 180_000);

test("a carried page's card is kept on the tree and not composed again", async () => {
  const dir = site(CARRIED_SITE, CROSS_PAGE_CARDS);
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const before = readFileSync(join(dist, "index.html"), "utf8");

  writeFileSync(
    join(dir, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "Edited" } })}\n`,
  );
  await ok(dir, "sync");
  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const built = await buildSite({
    config: await loadConfig(dir),
    incremental: true,
    stamp: { id: "social-carried", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");

  expect(patch.stats.rendered).toBe(1);
  expect(patch.stats.reused).toBe(1);
  const after = readFileSync(join(dist, "index.html"), "utf8");
  expect(after).toBe(before);

  const href = /<meta property="og:image" content="([^"]*)">/.exec(after)?.[1];
  expect(href).toMatch(/^\/social\/en\.[0-9a-f]{8}\.png$/);
  expect(existsSync(join(dist, String(href).slice(1)))).toBe(true);
  expect(patch.written.map((file) => file.path)).not.toContain(href);
  expect(
    patch.written.filter((file) => file.path.startsWith("/social/")),
  ).toHaveLength(1);
}, 240_000);

test("a card the tree lost under a carried page is not kept and not drawn again", async () => {
  const dir = site(TAMPERED_SITE, CROSS_PAGE_CARDS);
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const home = readFileSync(join(dist, "index.html"), "utf8");
  const href = String(
    /<meta property="og:image" content="([^"]*)">/.exec(home)?.[1],
  );
  writeFileSync(join(dist, href.slice(1)), "edited under the build\n");

  writeFileSync(
    join(dir, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "Edited" } })}\n`,
  );
  await ok(dir, "sync");
  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const built = await buildSite({
    config: await loadConfig(dir),
    incremental: true,
    stamp: { id: "social-tampered", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");

  expect(patch.stats.reused).toBe(1);
  expect(
    patch.written.filter((file) => file.path.startsWith("/social/")),
  ).toHaveLength(1);
  expect(patch.pruned.map((one) => one.path)).toContain(href);
  expect(existsSync(join(dist, href.slice(1)))).toBe(false);
}, 240_000);

test("a component contradicting a tag the card derived fails the build", async () => {
  const dir = site(CLAIMED_SITE, DECLARED_CARDS, CARD_COMPONENT);
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).toContain(
    '2 claims on <meta name="twitter:card"> disagree',
  );
  expect(result.err).toContain("the build's own <head> — \"summary_large_image\"");
  expect(result.err).toContain('"Hero" — "summary"');
}, 180_000);

test("every output tree gets the card its own page's og:image names", async () => {
  const dist = await build(TREES_SITE, DECLARED_CARDS, TWO_TREES, ["en", "de"]);

  for (const tree of ["example.com", "example.de"]) {
    const page = readFileSync(join(dist, tree, "index.html"), "utf8");
    const href = /<meta property="og:image" content="([^"]*)">/.exec(page)?.[1];
    expect(href).toMatch(/^\/social\/[a-z-]+\.[0-9a-f]{8}\.png$/);
    expect(existsSync(join(dist, tree, String(href).slice(1)))).toBe(true);
  }
  expect(existsSync(join(dist, "social"))).toBe(false);
}, 180_000);

test("a carried page keeps its card in the tree that serves it", async () => {
  const dir = site(CARRIED_TREES_SITE, CROSS_PAGE_CARDS, COMPONENT, TWO_TREES, [
    "en",
    "de",
  ]);
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const before = readFileSync(join(dist, "example.de", "index.html"), "utf8");

  writeFileSync(
    join(dir, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "Edited" } })}\n`,
  );
  await ok(dir, "sync");
  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const built = await buildSite({
    config: await loadConfig(dir),
    incremental: true,
    stamp: { id: "social-carried-trees", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");

  expect(patch.stats.reused).toBeGreaterThan(0);
  const after = readFileSync(join(dist, "example.de", "index.html"), "utf8");
  expect(after).toBe(before);

  const href = String(
    /<meta property="og:image" content="([^"]*)">/.exec(after)?.[1],
  );
  expect(href).toMatch(/^\/social\/[a-z-]+\.[0-9a-f]{8}\.png$/);
  expect(existsSync(join(dist, "example.de", href.slice(1)))).toBe(true);
  expect(
    patch.written.map((file) => `${file.domain ?? ""}|${file.path}`),
  ).not.toContain(`example.de|${href}`);
}, 240_000);

test("a card missing from one tree is lost in that tree alone", async () => {
  const dir = site(PARTIAL_SITE, DECLARED_CARDS, COMPONENT, TWO_TREES, [
    "en",
    "de",
  ]);
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const before = readFileSync(join(dist, "example.com", "index.html"), "utf8");
  const href = String(
    /<meta property="og:image" content="([^"]*)">/.exec(before)?.[1],
  );
  expect(href).toMatch(/^\/social\/[a-z-]+\.[0-9a-f]{8}\.png$/);
  expect(existsSync(join(dist, "example.com", href.slice(1)))).toBe(true);
  expect(existsSync(join(dist, "example.de", href.slice(1)))).toBe(true);
  rmSync(join(dist, "example.com", href.slice(1)));

  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const built = await buildSite({
    config: await loadConfig(dir),
    incremental: true,
    stamp: { id: "social-partial", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");

  expect(patch.stats.reused).toBeGreaterThan(0);
  expect(readFileSync(join(dist, "example.com", "index.html"), "utf8")).toBe(
    before,
  );

  expect(existsSync(join(dist, "example.de", href.slice(1)))).toBe(true);
  expect(
    patch.written.map((file) => `${file.domain ?? ""}|${file.path}`),
  ).not.toContain(`example.de|${href}`);
  expect(existsSync(join(dist, "example.com", href.slice(1)))).toBe(false);
  expect(
    built.manifest.files
      .filter((row) => row.path === href)
      .map((row) => row.domain ?? ""),
  ).toEqual(["example.de"]);
}, 240_000);

test("a card in a tree the locale set no longer declares is not carried", async () => {
  const dir = site(DROPPED_TREE_SITE, DECLARED_CARDS, COMPONENT, TWO_TREES, [
    "en",
    "de",
  ]);
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const before = readFileSync(join(dist, "example.com", "index.html"), "utf8");
  const href = String(
    /<meta property="og:image" content="([^"]*)">/.exec(before)?.[1],
  );
  expect(existsSync(join(dist, "example.de", href.slice(1)))).toBe(true);

  const configPath = join(dir, "pagedeck.config.ts");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(', domain: "example.de"', ""),
  );

  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const built = await buildSite({
    // Reloaded: this config changes between the two builds, and Node answers a `file:` URL
    // it has imported once from its module cache.
    config: await loadConfig(dir, { reload: true }),
    incremental: true,
    stamp: { id: "social-dropped-tree", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");
  expect(patch.stats.reused).toBeGreaterThan(0);
  expect(readFileSync(join(dist, "example.com", "index.html"), "utf8")).toBe(
    before,
  );

  expect(built.manifest.files.filter((row) => row.domain === "example.de")).toEqual(
    [],
  );
  expect(existsSync(join(dist, "example.de", href.slice(1)))).toBe(false);
}, 240_000);
