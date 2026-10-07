import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { ConfigError, EXIT_CODES } from "./exit.js";
import { checkSiteLinks } from "./links.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENT = `export default function Hero() { return "marker-hero-6a11"; }\n`;

const PLAIN_SITE = join(SITES, ".pagedeck-fonts-plain-test");
const DECLARED_SITE = join(SITES, ".pagedeck-fonts-declared-test");
const REBUILD_SITE = join(SITES, ".pagedeck-fonts-rebuild-test");
const MISSING_SITE = join(SITES, ".pagedeck-fonts-missing-test");
const INCREMENTAL_SITE = join(SITES, ".pagedeck-fonts-incremental-test");
const REFUSING_SITE = join(SITES, ".pagedeck-fonts-refusing-test");
const CRASHING_SITE = join(SITES, ".pagedeck-fonts-crashing-test");
const TREES_SITE = join(SITES, ".pagedeck-fonts-trees-test");

const ONE_TREE = `en: { label: "en", direction: "ltr" },`;
const TWO_TREES = `en: { label: "en", direction: "ltr", domain: "example.com" },
        de: { label: "de", direction: "ltr", domain: "example.de" },`;

const STUB_ADAPTER = `{
      name: "stub-subsetter",
      subset: (request) => ({
        bytes: new TextEncoder().encode(
          "wOF2:" + request.family + ":" + request.src + ":" + request.unicodeRanges.join(","),
        ),
        metrics: { unitsPerEm: 1000, ascent: 950, descent: 250, lineGap: 0, xHeight: 520 },
      }),
    }`;

const TWO_FACES = `[
      {
        family: "Acme Sans",
        src: "./fonts/acme-sans.ttf",
        weight: 400,
        style: "normal",
        display: "swap",
        aboveFold: true,
        unicodeRanges: ["U+0000-00FF", "U+0131"],
        fallback: ["Georgia"],
      },
      {
        family: "Acme Mono",
        src: "./fonts/acme-mono.ttf",
        weight: 400,
        style: "normal",
        display: "swap",
        unicodeRanges: ["U+0000-00FF"],
        fallback: ["Courier New"],
      },
    ]`;

const DECLARED_FONTS = `fonts: { adapter: ${STUB_ADAPTER}, faces: ${TWO_FACES} },`;

const REFUSING_ADAPTER = `{
      name: "stub-subsetter",
      subset: (request) => {
        throw new ConfigError(
          'Font subset: the "stub-subsetter" adapter was asked for ranges this font has no glyph for — narrow "build.fonts.faces" to ranges the source covers',
        );
      },
    }`;

const CRASHING_ADAPTER = `{
      name: "stub-subsetter",
      subset: (request) => {
        throw new TypeError("cannot read properties of undefined");
      },
    }`;

const REFUSING_FONTS = `fonts: { adapter: ${REFUSING_ADAPTER}, faces: ${TWO_FACES} },`;
const CRASHING_FONTS = `fonts: { adapter: ${CRASHING_ADAPTER}, faces: ${TWO_FACES} },`;

const MISSING_FONTS = `fonts: {
      adapter: ${STUB_ADAPTER},
      faces: [
        { family: "Acme Sans", src: "./fonts/acme-sans.ttf", weight: 400, style: "normal", display: "swap", unicodeRanges: ["U+0000-00FF"], fallback: ["Georgia"] },
        { family: "Acme Serif", src: "./fonts/acme-serif.ttf", weight: 700, style: "italic", display: "swap", unicodeRanges: ["U+0000-00FF"], fallback: ["Georgia"] },
      ],
    },`;

function site(
  root: string,
  fonts = "",
  writeFonts = true,
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
  entries: readonly string[] = ["home"],
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Hero.js"), COMPONENT);
  if (writeFonts) {
    mkdirSync(join(root, "fonts"), { recursive: true });
    writeFileSync(join(root, "fonts", "acme-sans.ttf"), "not a real font, only its presence matters");
    writeFileSync(join(root, "fonts", "acme-mono.ttf"), "not a real font, only its presence matters");
  }
  for (const locale of contentLocales) {
    for (const entry of entries) {
      const file = join(root, "content", locale, `${entry}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title: entry === "home" ? "Home" : entry } })}\n`);
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
    ${fonts}
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
  fonts = "",
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): Promise<string> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, fonts, locales, contentLocales);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  fonts: string,
  locales: string,
  contentLocales: readonly string[],
): Promise<string> {
  const dir = site(root, fonts, true, locales, contentLocales);
  await ok(dir, "sync");
  await ok(dir, "build");
  return join(dir, "dist");
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    DECLARED_SITE,
    REBUILD_SITE,
    MISSING_SITE,
    INCREMENTAL_SITE,
    REFUSING_SITE,
    CRASHING_SITE,
    TREES_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site that declares no fonts builds the tree it built without the field", async () => {
  const plain = await build(PLAIN_SITE);
  const declared = await build(DECLARED_SITE, DECLARED_FONTS);
  const withoutFonts = await build(join(SITES, ".pagedeck-fonts-plain-again-test"), "");

  expect(diffOutputTrees(plain, withoutFonts)).toEqual([]);
  expect(diffOutputTrees(plain, declared)).not.toEqual([]);
  rmSync(join(SITES, ".pagedeck-fonts-plain-again-test"), { recursive: true, force: true });
}, 120_000);

test("a declared face's subset is written as a content-hashed asset and hashed into the manifest", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_FONTS);

  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  const subset = manifest.files.find(
    (row) => row.path.startsWith("/fonts/") && row.path.includes("acme-sans"),
  );

  expect(subset?.kind).toBe("asset");
  expect(subset?.path).toMatch(/^\/fonts\/acme-sans-400-normal\.[0-9a-f]{8}\.woff2$/);
  expect(subset?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

  const bytes = readFileSync(join(dist, (subset?.path as string).slice(1)), "utf8");
  expect(bytes).toBe(
    `wOF2:Acme Sans:${join(DECLARED_SITE, "fonts", "acme-sans.ttf")}:U+0000-00FF,U+0131`,
  );
}, 120_000);

test("the font stylesheet is linked on the page and carries both faces' rules", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_FONTS);
  const page = readFileSync(join(dist, "index.html"), "utf8");

  const hrefMatch = /<link rel="stylesheet" href="(\/fonts\/fonts\.[0-9a-f]{8}\.css)">/.exec(
    page,
  );
  expect(hrefMatch).not.toBeNull();
  const css = readFileSync(join(dist, (hrefMatch?.[1] as string).slice(1)), "utf8");

  expect(css).toContain('font-family: "Acme Sans"');
  expect(css).toContain('font-family: "Acme Mono"');
  expect(css).toContain('src: local("Georgia")');
  expect(css).toContain('src: local("Courier New")');
}, 120_000);

test("two builds of one unchanged site write the subset at the identical path", async () => {
  const first = join(await build(REBUILD_SITE, DECLARED_FONTS), "manifest.json");
  const firstManifest = readManifest(readFileSync(first, "utf8"), first);
  const firstPath = firstManifest.files.find((row) => row.path.includes("acme-sans"))?.path;

  // A second build, not the cached promise: the claim is about two runs agreeing.
  await ok(REBUILD_SITE, "build");
  const second = join(REBUILD_SITE, "dist", "manifest.json");
  const secondManifest = readManifest(readFileSync(second, "utf8"), second);
  const secondPath = secondManifest.files.find((row) => row.path.includes("acme-sans"))?.path;

  expect(firstPath).toBeDefined();
  expect(secondPath).toBe(firstPath);
}, 180_000);

test("a preload link reaches the page for the above-fold face and not for the below-fold one", async () => {
  const dist = await build(DECLARED_SITE, DECLARED_FONTS);
  const page = readFileSync(join(dist, "index.html"), "utf8");

  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  const sansHref = manifest.files.find((row) => row.path.includes("acme-sans"))?.path;
  const monoHref = manifest.files.find((row) => row.path.includes("acme-mono"))?.path;

  expect(page).toContain(
    `<link rel="preload" href="${String(sansHref)}" as="font" type="font/woff2" crossorigin>`,
  );
  expect(page).not.toContain(`href="${String(monoHref)}" as="font"`);
}, 120_000);

test("a missing source file fails the build, naming every face that has one", async () => {
  const dir = site(MISSING_SITE, MISSING_FONTS, false);

  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain('"build.fonts.faces" declares 2 faces');
  expect(result.err).toContain('faces[0] ("Acme Sans")');
  expect(result.err).toContain("acme-sans.ttf");
  expect(result.err).toContain('faces[1] ("Acme Serif")');
  expect(result.err).toContain("acme-serif.ttf");
  expect(result.err).toContain("does not exist");
}, 120_000);

test("an incremental build of a site with fonts declared succeeds and emits the same font filename a full build emits", async () => {
  const dir = site(INCREMENTAL_SITE, DECLARED_FONTS);
  await ok(dir, "sync");
  await ok(dir, "build");

  const fullManifestFile = join(dir, "dist", "manifest.json");
  const fullManifest = readManifest(readFileSync(fullManifestFile, "utf8"), fullManifestFile);
  const fullPath = fullManifest.files.find((row) => row.path.includes("acme-sans"))?.path;
  expect(fullPath).toBeDefined();

  const result = await run(dir, "build", "--incremental");
  expect(result.code).toBe(EXIT_CODES.success);

  const incrementalManifest = readManifest(readFileSync(fullManifestFile, "utf8"), fullManifestFile);
  const incrementalPath = incrementalManifest.files.find((row) =>
    row.path.includes("acme-sans"),
  )?.path;

  expect(incrementalPath).toBe(fullPath);
}, 120_000);


test("an adapter that refuses the site's config exits 2, carrying its own refusal", async () => {
  const dir = site(REFUSING_SITE, REFUSING_FONTS);
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("no glyph for");
  expect(result.err).not.toContain("threw while subsetting");
}, 120_000);

test("an adapter that crashes exits 1, wrapped in a message naming the adapter and the face", async () => {
  const dir = site(CRASHING_SITE, CRASHING_FONTS);
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).toContain(
    'Font subset: the "stub-subsetter" adapter threw while subsetting faces[0] ("Acme Sans")',
  );
  expect(result.err).toContain("cannot read properties of undefined");
}, 120_000);

test("every output tree gets the subsets and the stylesheet its own pages link", async () => {
  const dist = await build(TREES_SITE, DECLARED_FONTS, TWO_TREES, ["en", "de"]);

  const page = readFileSync(join(dist, "example.de", "index.html"), "utf8");
  const styleHref = /<link rel="stylesheet" href="(\/fonts\/fonts\.[0-9a-f]{8}\.css)">/.exec(
    page,
  )?.[1];
  const preloadHref = /<link rel="preload" href="(\/fonts\/[^"]+)" as="font"/.exec(page)?.[1];
  expect(styleHref).toBeDefined();
  expect(preloadHref).toBeDefined();

  for (const tree of ["example.com", "example.de"]) {
    expect(existsSync(join(dist, tree, String(styleHref).slice(1)))).toBe(true);
    expect(existsSync(join(dist, tree, String(preloadHref).slice(1)))).toBe(true);
  }
  expect(existsSync(join(dist, "fonts"))).toBe(false);

  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  const paths = [
    ...new Set(
      manifest.files.filter((row) => row.path.startsWith("/fonts/")).map((row) => row.path),
    ),
  ];
  expect(paths).toHaveLength(3);
  for (const path of paths) {
    expect(
      manifest.files
        .filter((row) => row.path === path)
        .map((row) => row.domain ?? "")
        .sort(),
    ).toEqual(["example.com", "example.de"]);
  }

  const withheld = manifest.files
    .filter(
      (row) => !(row.domain === "example.de" && row.path.startsWith("/fonts/")),
    )
    .map((row) => ({
      ...(row.domain === undefined ? {} : { domain: row.domain }),
      path: row.path,
      kind: row.kind,
      contents:
        row.domain === "example.de" && row.path === "/index.html" ? page : "",
    }));
  const refusal = await checkSiteLinks({
    files: withheld,
    routing: manifest.routing,
    check: { broken: "error" },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(ConfigError);
  const message = refusal instanceof Error ? refusal.message : "";
  expect(message).toContain("references name nothing this build emitted");
  expect(message).toContain(String(styleHref));
  expect(message).toContain(String(preloadHref));
}, 180_000);

// Its bytes name no path on this machine, so hrefs and manifest rows are the same on
// any checkout.
const PORTABLE_ADAPTER = `{
      name: "stub-subsetter",
      subset: (request) => ({
        bytes: new TextEncoder().encode(
          "wOF2:" + request.family + ":" + request.unicodeRanges.join(","),
        ),
        metrics: { unitsPerEm: 1000, ascent: 950, descent: 250, lineGap: 0, xHeight: 520 },
      }),
    }`;

const GOLDEN_SITE = join(SITES, ".pagedeck-fonts-golden-test");

test("a site that scopes no face emits the font bytes it emitted before faces could be scoped", async () => {
  const dir = site(
    GOLDEN_SITE,
    `fonts: { adapter: ${PORTABLE_ADAPTER}, faces: ${TWO_FACES} },`,
    true,
    ONE_TREE,
    ["en"],
    ["home", "features"],
  );
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");

  const raw = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as {
    files: readonly { path: string }[];
  };
  const rows = raw.files.filter((row) => row.path.startsWith("/fonts/"));
  const fontTags = (file: string): string[] =>
    readFileSync(join(dist, file), "utf8").match(/<link[^>]*\/fonts\/[^>]*>/g) ?? [];
  const sheet = rows.find((row) => row.path.endsWith(".css"))?.path as string;

  expect({
    rows: JSON.stringify(rows),
    css: readFileSync(join(dist, sheet.slice(1)), "utf8"),
    home: fontTags("index.html"),
    features: fontTags("features/index.html"),
  }).toMatchInlineSnapshot(`
    {
      "css": "@font-face {
      font-family: "Acme Sans";
      src: url("/fonts/acme-sans-400-normal.d2123e0f.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
      unicode-range: U+0000-00FF, U+0131;
    }

    @font-face {
      font-family: "Georgia";
      src: local("Georgia");
      font-weight: 400;
      font-style: normal;
      size-adjust: 108.0081%;
      ascent-override: 87.9564%;
      descent-override: 23.1464%;
      line-gap-override: 0.0000%;
    }

    @font-face {
      font-family: "Acme Mono";
      src: url("/fonts/acme-mono-400-normal.13b6523c.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
      unicode-range: U+0000-00FF;
    }

    @font-face {
      font-family: "Courier New";
      src: local("Courier New");
      font-weight: 400;
      font-style: normal;
      size-adjust: 122.9746%;
      ascent-override: 77.2517%;
      descent-override: 20.3294%;
      line-gap-override: 0.0000%;
    }",
      "features": [
        "<link rel="preload" href="/fonts/acme-sans-400-normal.d2123e0f.woff2" as="font" type="font/woff2" crossorigin>",
        "<link rel="stylesheet" href="/fonts/fonts.27ab189c.css">",
      ],
      "home": [
        "<link rel="preload" href="/fonts/acme-sans-400-normal.d2123e0f.woff2" as="font" type="font/woff2" crossorigin>",
        "<link rel="stylesheet" href="/fonts/fonts.27ab189c.css">",
      ],
      "rows": "[{"path":"/fonts/acme-mono-400-normal.13b6523c.woff2","kind":"asset","hash":"sha256:13b6523c9f827abaa03ae81db2ce362a343e18876585be6fabf74f185636fb66","size":26,"hashed":true},{"path":"/fonts/acme-sans-400-normal.d2123e0f.woff2","kind":"asset","hash":"sha256:d2123e0ffcb2f6225b774ae051d6edff958a7f74491173383615d61c68a35cec","size":33,"hashed":true},{"path":"/fonts/fonts.27ab189c.css","kind":"css","hash":"sha256:27ab189c1512f0d6cec2bcaaabb09c88b406fb4bddf735b9625ad74e0342db1c","size":886,"hashed":true}]",
    }
  `);
  rmSync(GOLDEN_SITE, { recursive: true, force: true });
}, 120_000);

function scopedFaces(pages: string): string {
  return `[
      {
        family: "Acme Sans",
        src: "./fonts/acme-sans.ttf",
        weight: 400,
        style: "normal",
        display: "swap",
        aboveFold: true,
        unicodeRanges: ["U+0000-00FF"],
        fallback: ["Georgia"],
      },
      {
        family: "Acme Mono",
        src: "./fonts/acme-mono.ttf",
        weight: 400,
        style: "normal",
        display: "swap",
        aboveFold: true,
        unicodeRanges: ["U+0000-00FF"],
        fallback: ["Courier New"],
        pages: ${pages},
      },
      {
        family: "Acme Mono",
        src: "./fonts/acme-mono.ttf",
        weight: 700,
        style: "normal",
        display: "swap",
        unicodeRanges: ["U+0000-00FF"],
        fallback: ["Courier New"],
        pages: ${pages},
      },
    ]`;
}

const SCOPED_SITE = join(SITES, ".pagedeck-fonts-scoped-test");
const ONLY_SCOPED_SITE = join(SITES, ".pagedeck-fonts-only-scoped-test");
const UNMATCHED_SITE = join(SITES, ".pagedeck-fonts-unmatched-test");
const RESCOPED_SITE = join(SITES, ".pagedeck-fonts-rescoped-test");
const RESCOPED_FULL_SITE = join(SITES, ".pagedeck-fonts-rescoped-full-test");
const RESCOPED_MERGED_SITE = join(SITES, ".pagedeck-fonts-rescoped-merged-test");

const THREE_PAGES = ["home", "features", "other"] as const;

async function buildScoped(root: string, faces: string): Promise<string> {
  const dir = site(
    root,
    `fonts: { adapter: ${PORTABLE_ADAPTER}, faces: ${faces} },`,
    true,
    ONE_TREE,
    ["en"],
    THREE_PAGES,
  );
  await ok(dir, "sync");
  await ok(dir, "build");
  return join(dir, "dist");
}

function fontLinks(dist: string, file: string): { sheets: string[]; preloads: string[] } {
  const html = readFileSync(join(dist, file), "utf8");
  return {
    sheets: [...html.matchAll(/<link rel="stylesheet" href="(\/fonts\/[^"]+)">/g)].map(
      (match) => match[1] as string,
    ),
    preloads: [...html.matchAll(/<link rel="preload" href="(\/fonts\/[^"]+)" as="font"/g)].map(
      (match) => match[1] as string,
    ),
  };
}

test("a scoped face's stylesheet and preload go on the pages its patterns match, and nowhere else", async () => {
  const dist = await buildScoped(SCOPED_SITE, scopedFaces(`["/features"]`));

  const home = fontLinks(dist, "index.html");
  const other = fontLinks(dist, "other/index.html");
  const features = fontLinks(dist, "features/index.html");

  expect(home.sheets).toHaveLength(1);
  expect(other).toEqual(home);
  const [everywhere] = home.sheets as [string];

  expect(features.sheets).toHaveLength(2);
  expect(features.sheets[0]).toBe(everywhere);
  const scoped = features.sheets[1] as string;

  const everywhereCss = readFileSync(join(dist, everywhere.slice(1)), "utf8");
  const scopedCss = readFileSync(join(dist, scoped.slice(1)), "utf8");
  expect(everywhereCss).toContain('font-family: "Acme Sans"');
  expect(everywhereCss).toContain('src: local("Georgia")');
  expect(everywhereCss).not.toContain("Acme Mono");
  expect(everywhereCss).not.toContain("Courier New");
  expect(scopedCss.match(/font-family: "Acme Mono"/g)).toHaveLength(2);
  expect(scopedCss.match(/src: local\("Courier New"\)/g)).toHaveLength(2);
  expect(scopedCss).not.toContain("Acme Sans");

  expect(home.preloads).toEqual([expect.stringMatching(/^\/fonts\/acme-sans-400-normal\./)]);
  expect(features.preloads).toEqual([
    home.preloads[0],
    expect.stringMatching(/^\/fonts\/acme-mono-400-normal\./),
  ]);

  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  expect(manifest.files.find((row) => row.path === scoped)?.fontPages).toEqual(["/features"]);
  expect(manifest.files.find((row) => row.path === everywhere)).not.toHaveProperty("fontPages");
}, 120_000);

test("a site whose every face is scoped links no font stylesheet on a page no pattern matches", async () => {
  const faces = scopedFaces(`["/features"]`).replace(
    'fallback: ["Georgia"],',
    'fallback: ["Georgia"],\n        pages: ["/features"],',
  );
  const dist = await buildScoped(ONLY_SCOPED_SITE, faces);

  expect(fontLinks(dist, "index.html")).toEqual({ sheets: [], preloads: [] });
  expect(fontLinks(dist, "other/index.html")).toEqual({ sheets: [], preloads: [] });
  const features = fontLinks(dist, "features/index.html");
  expect(features.sheets).toHaveLength(1);
  expect(features.preloads).toHaveLength(2);
}, 120_000);

const CRITICAL_SITE = join(SITES, ".pagedeck-fonts-critical-test");

test("a page criticalCss flags inlines its font stylesheets ahead of its other sheets, and an unflagged page still links them", async () => {
  const dir = site(
    CRITICAL_SITE,
    `fonts: { adapter: ${PORTABLE_ADAPTER}, faces: ${scopedFaces(`["/features"]`)} },
    criticalCss: { "/features": true },`,
    true,
    ONE_TREE,
    ["en"],
    THREE_PAGES,
  );
  writeFileSync(
    join(dir, "components", "Hero.js"),
    `import "./Hero.css";\n${COMPONENT}`,
  );
  writeFileSync(join(dir, "components", "Hero.css"), `.fw-hero { color: rgb(6, 1, 1); }\n`);
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");

  const home = fontLinks(dist, "index.html");
  expect(home.sheets).toHaveLength(1);
  const [everywhere] = home.sheets as [string];
  const scoped = readdirSync(join(dist, "fonts"))
    .map((name) => `/fonts/${name}`)
    .find((href) => href.endsWith(".css") && href !== everywhere) as string;

  const features = readFileSync(join(dist, "features", "index.html"), "utf8");
  expect(fontLinks(dist, "features/index.html").sheets).toEqual([]);
  const styles = [...features.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    (match) => match[1] as string,
  );
  expect(styles.slice(0, 2)).toEqual([
    readFileSync(join(dist, everywhere.slice(1)), "utf8"),
    readFileSync(join(dist, scoped.slice(1)), "utf8"),
  ]);
  expect(styles).toHaveLength(3);
  expect(styles[2]).toContain(".fw-hero");
}, 120_000);

test("a face's page pattern that matches no page fails the build, naming the face and the pattern", async () => {
  const dir = site(
    UNMATCHED_SITE,
    `fonts: { adapter: ${PORTABLE_ADAPTER}, faces: ${scopedFaces(`["/features", "/featurs"]`)} },`,
    true,
    ONE_TREE,
    ["en"],
    THREE_PAGES,
  );
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `Config "${join(dir, "pagedeck.config.ts")}": "build.fonts.faces" declares 2 page patterns that match no page of this build — correct each to a page this build routes, or remove it:\n  faces[1] ("Acme Mono") — "/featurs"\n  faces[2] ("Acme Mono") — "/featurs"`,
  );
}, 120_000);

test("an incremental build after a scoped face's pattern changes emits the tree a full build emits", async () => {
  await buildScoped(RESCOPED_SITE, scopedFaces(`["/features"]`));
  const full = await buildScoped(RESCOPED_FULL_SITE, scopedFaces(`["/other"]`));

  // A copy, not the site itself: this process has imported the first config, and Node
  // caches it by URL.
  rmSync(RESCOPED_MERGED_SITE, { recursive: true, force: true });
  cpSync(RESCOPED_SITE, RESCOPED_MERGED_SITE, { recursive: true });
  const config = join(RESCOPED_MERGED_SITE, "pagedeck.config.ts");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replaceAll(`pages: ["/features"]`, `pages: ["/other"]`),
  );
  const result = await run(RESCOPED_MERGED_SITE, "build", "--incremental");
  expect(result.code, result.err).toBe(EXIT_CODES.success);
  expect(result.out).toContain("incremental: 2 of 3 pages rendered, 1 reused, 0 removed");

  const second = join(RESCOPED_MERGED_SITE, "dist");
  expect(fontLinks(second, "other/index.html").sheets).toHaveLength(2);
  expect(fontLinks(second, "features/index.html").sheets).toHaveLength(1);
  expect(diffOutputTrees(full, second)).toEqual([]);
}, 180_000);

afterAll(() => {
  for (const root of [
    SCOPED_SITE,
    ONLY_SCOPED_SITE,
    UNMATCHED_SITE,
    RESCOPED_SITE,
    RESCOPED_FULL_SITE,
    RESCOPED_MERGED_SITE,
    CRITICAL_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

const DUPLICATE_SITE = join(SITES, ".pagedeck-fonts-duplicate-test");
const TWO_FAULTS_SITE = join(SITES, ".pagedeck-fonts-two-faults-test");

test("a face declared twice under two scopes is refused, naming both declarations", async () => {
  const faces = scopedFaces(`["/features"]`).replace(
    /\]\s*$/,
    `  {
        family: "Acme Mono",
        src: "./fonts/acme-mono.ttf",
        weight: 400,
        style: "normal",
        display: "swap",
        aboveFold: true,
        unicodeRanges: ["U+0000-00FF"],
        fallback: ["Courier New"],
        pages: ["/other"],
      },
    ]`,
  );
  const dir = site(
    DUPLICATE_SITE,
    `fonts: { adapter: ${PORTABLE_ADAPTER}, faces: ${faces} },`,
    true,
    ONE_TREE,
    ["en"],
    THREE_PAGES,
  );
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `Config "${join(dir, "pagedeck.config.ts")}": "build.fonts.faces" declares 1 face more than once, and every copy would write the same subset file — declare the face once, and list every page it belongs on in its "pages":\n  faces[1] ("Acme Mono"), faces[3] ("Acme Mono")`,
  );
  rmSync(DUPLICATE_SITE, { recursive: true, force: true });
}, 120_000);

test("a missing source file and an unmatched pattern are reported by one build", async () => {
  const faces = scopedFaces(`["/featurs"]`).replace(
    'src: "./fonts/acme-sans.ttf"',
    'src: "./fonts/acme-serif.ttf"',
  );
  const dir = site(
    TWO_FAULTS_SITE,
    `fonts: { adapter: ${PORTABLE_ADAPTER}, faces: ${faces} },`,
    true,
    ONE_TREE,
    ["en"],
    THREE_PAGES,
  );
  await ok(dir, "sync");
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `"build.fonts.faces" declares 1 face whose source file does not exist — ${"point src at each face's real font file, or remove the declaration"}:\n  faces[0] ("Acme Sans")`,
  );
  expect(result.err).toContain(
    `"build.fonts.faces" declares 2 page patterns that match no page of this build — correct each to a page this build routes, or remove it:\n  faces[1] ("Acme Mono") — "/featurs"\n  faces[2] ("Acme Mono") — "/featurs"`,
  );
  rmSync(TWO_FAULTS_SITE, { recursive: true, force: true });
}, 120_000);
