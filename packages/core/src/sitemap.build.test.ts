import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { VARIANT_SEGMENT } from "./routing.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const ORIGIN = "https://example.com";
const PLAIN_SITE = join(SITES, ".pagedeck-sitemap-plain-test");
const SUFFIX_SITE = join(SITES, ".pagedeck-sitemap-suffix-test");
const DIRECTORY_SITE = join(SITES, ".pagedeck-sitemap-directory-test");
const MOVED_SITE = join(SITES, ".pagedeck-sitemap-moved-test");

const CONTENT: Record<string, readonly string[]> = {
  en: ["home", "pricing", "about"],
  de: ["home", "pricing", "impressum"],
  fr: ["home"],
};

const COMPONENT = `export default function Copy() { return "marker-copy-40a1"; }\n`;

const SPLIT = `
    routing: {
      experiments: [
        {
          locale: "en",
          path: "/pricing",
          cookie: "fw_pricing",
          variants: [
            { name: "b", weight: 50 },
            { name: "c", weight: 50 },
          ],
        },
      ],
    },`;

function site(
  root: string,
  declared = "",
  content: Record<string, readonly string[]> = CONTENT,
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  for (const [locale, paths] of Object.entries(content)) {
    for (const path of paths) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: {} })}\n`);
    }
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    origin: ${JSON.stringify(ORIGIN)},
    xDefault: "en",
    ${SPLIT}
    ${declared}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
        fr: { label: "Français", direction: "ltr", fallback: "en" },
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
  return root;
}

async function run(cwd: string, ...argv: string[]): Promise<number> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return code;
}

interface Built {
  readonly dist: string;
  readonly manifest: Manifest;
  readonly documents: ReadonlyMap<string, string>;
}

const built = new Map<string, Promise<Built>>();

function build(
  root: string,
  declared = "",
  content: Record<string, readonly string[]> = CONTENT,
): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, declared, content);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  declared: string,
  content: Record<string, readonly string[]>,
): Promise<Built> {
  const dir = site(root, declared, content);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return {
    dist,
    manifest,
    documents: new Map(
      manifest.pages.map((page) => [
        `${page.locale} ${page.path}`,
        readFileSync(join(dist, treeRelative(page.html)), "utf8"),
      ]),
    ),
  };
}

function treeRelative(key: string): string {
  return key.startsWith("//") ? key.slice(2) : key.slice(1);
}

function read(dist: string, key: string): string {
  return readFileSync(join(dist, treeRelative(key)), "utf8");
}

function locations(xml: string): readonly string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(
    (match) => match[1] ?? "",
  );
}

function entryAlternates(
  xml: string,
  loc: string,
): ReadonlyMap<string, string> {
  const entry = [...xml.matchAll(/<url>\n([\s\S]*?)<\/url>/g)].find((match) =>
    (match[1] ?? "").includes(`<loc>${loc}</loc>`),
  );
  return new Map(
    [
      ...(entry?.[1] ?? "").matchAll(/hreflang="([^"]*)" href="([^"]*)"\/>/g),
    ].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}

function documentAlternates(html: string): ReadonlyMap<string, string> {
  return new Map(
    [
      ...html.matchAll(
        /<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g,
      ),
    ].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    SUFFIX_SITE,
    DIRECTORY_SITE,
    MOVED_SITE,
    ...merged,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SUFFIX = `sitemap: { pattern: "suffix" },`;
const DIRECTORY = `sitemap: { pattern: "directory" },`;

test("a site that declares no sitemap builds the tree it built without the field", async () => {
  const plain = await build(PLAIN_SITE);
  const suffix = await build(SUFFIX_SITE, SUFFIX);

  const moved = diffOutputTrees(plain.dist, suffix.dist);
  expect(moved.filter((one) => one.difference !== "second-only")).toEqual([
    { path: "manifest.json", difference: "bytes" },
  ]);
  expect(moved.map((one) => one.path).sort()).toEqual([
    "example.de/sitemap-de.xml",
    "example.de/sitemap.xml",
    "manifest.json",
    "sitemap-en.xml",
    "sitemap-fr.xml",
    "sitemap.xml",
  ]);
}, 120_000);

test("the suffix pattern writes a sitemap per locale at its tree's root", async () => {
  const suffix = await build(SUFFIX_SITE, SUFFIX);

  expect(locations(read(suffix.dist, "/sitemap-en.xml"))).toEqual([
    "https://example.com/en",
    "https://example.com/en/about",
    "https://example.com/en/pricing",
  ]);
  expect(locations(read(suffix.dist, "//example.de/sitemap-de.xml"))).toEqual([
    "https://example.de/",
    "https://example.de/impressum",
    "https://example.de/pricing",
  ]);
}, 120_000);

test("the directory pattern writes each locale's sitemap under its own segment", async () => {
  const directory = await build(DIRECTORY_SITE, DIRECTORY);

  expect(locations(read(directory.dist, "/en/sitemap.xml"))).toEqual([
    "https://example.com/en",
    "https://example.com/en/about",
    "https://example.com/en/pricing",
  ]);
  expect(
    locations(read(directory.dist, "//example.de/de/sitemap.xml")),
  ).toEqual([
    "https://example.de/",
    "https://example.de/impressum",
    "https://example.de/pricing",
  ]);
  const suffix = await build(SUFFIX_SITE, SUFFIX);
  expect(read(directory.dist, "/en/sitemap.xml")).toBe(
    read(suffix.dist, "/sitemap-en.xml"),
  );
}, 120_000);

test("each tree's index names that tree's sitemaps and no other tree's", async () => {
  const suffix = await build(SUFFIX_SITE, SUFFIX);

  expect(locations(read(suffix.dist, "/sitemap.xml"))).toEqual([
    "https://example.com/sitemap-en.xml",
    "https://example.com/sitemap-fr.xml",
  ]);
  expect(locations(read(suffix.dist, "//example.de/sitemap.xml"))).toEqual([
    "https://example.de/sitemap-de.xml",
  ]);
}, 120_000);

test("an entry's alternates are the emitted page's own hreflang links", async () => {
  const suffix = await build(SUFFIX_SITE, SUFFIX);
  const byCanonical = new Map(
    [...suffix.documents.values()].map((html) => [
      /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1] ?? "",
      html,
    ]),
  );

  let checked = 0;
  for (const key of [
    "/sitemap-en.xml",
    "/sitemap-fr.xml",
    "//example.de/sitemap-de.xml",
  ]) {
    const xml = read(suffix.dist, key);
    for (const loc of locations(xml)) {
      const html = byCanonical.get(loc);
      expect(html).toBeDefined();
      expect(entryAlternates(xml, loc)).toEqual(
        documentAlternates(html ?? ""),
      );
      checked += 1;
    }
  }
  expect(checked).toBe(9);
}, 120_000);

test("no experiment arm appears in any sitemap", async () => {
  const suffix = await build(SUFFIX_SITE, SUFFIX);
  const row = suffix.manifest.pages.find(
    (one) => one.locale === "en" && one.path === "/pricing",
  );
  expect(row?.variants?.map((one) => one.name)).toEqual(["b", "c"]);

  for (const key of [
    "/sitemap.xml",
    "/sitemap-en.xml",
    "/sitemap-fr.xml",
    "//example.de/sitemap.xml",
    "//example.de/sitemap-de.xml",
  ]) {
    expect(read(suffix.dist, key)).not.toContain(VARIANT_SEGMENT);
  }
}, 120_000);

test("a sitemap and its index are hashed into the manifest like every other file", async () => {
  const suffix = await build(SUFFIX_SITE, SUFFIX);

  for (const key of ["/sitemap.xml", "//example.de/sitemap-de.xml"]) {
    const file = suffix.manifest.files.find(
      (one) =>
        (one.domain === undefined ? one.path : `//${one.domain}${one.path}`) ===
        key,
    );
    expect(file?.kind).toBe("asset");
    expect(file?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(file?.size).toBe(
      readFileSync(join(suffix.dist, treeRelative(key))).byteLength,
    );
  }
}, 120_000);

test("a page added to one tree moves that tree's sitemap and no other file", async () => {
  const suffix = await build(SUFFIX_SITE, SUFFIX);
  const moved = await build(MOVED_SITE, SUFFIX, {
    ...CONTENT,
    de: [...(CONTENT["de"] ?? []), "kontakt"],
  });

  expect(
    diffOutputTrees(suffix.dist, moved.dist)
      .filter((one) => one.path.endsWith(".xml"))
      .map((one) => one.path),
  ).toEqual(["example.de/sitemap-de.xml"]);
  expect(locations(read(moved.dist, "//example.de/sitemap-de.xml"))).toContain(
    "https://example.de/kontakt",
  );
}, 120_000);

// Written out, not read off the manifest: a list taken from the build being measured
// could not fail.
const SITEMAP_KEYS = [
  "//example.de/sitemap-de.xml",
  "//example.de/sitemap.xml",
  "/sitemap-en.xml",
  "/sitemap-fr.xml",
  "/sitemap.xml",
] as const;

const LOCALE_SITEMAPS = SITEMAP_KEYS.filter(
  (key) => !key.endsWith("/sitemap.xml"),
);

const INDEXES = SITEMAP_KEYS.filter((key) => key.endsWith("/sitemap.xml"));

const merged: string[] = [];

interface Merged {
  readonly dist: string;
  readonly before: ReadonlyMap<string, string>;
  readonly after: ReadonlyMap<string, string>;
  readonly written: readonly string[];
  readonly full: ReadonlyMap<string, string>;
  readonly stats: { rendered: number; reused: number; removed: number };
}

// Through `buildSite`, not the verb: only `SitePatch.written` says a run composed a file.
// A directory per case, because Node caches a config module by URL.
async function merge(
  name: string,
  content: Record<string, readonly string[]>,
  mutate: (root: string) => void,
  compare = false,
): Promise<Merged> {
  const root = join(SITES, `.pagedeck-sitemap-${name}-test`);
  merged.push(root);
  site(root, SUFFIX, content);
  await run(root, "sync");
  await run(root, "build");
  const dist = join(root, "dist");
  const before = new Map(SITEMAP_KEYS.map((key) => [key, read(dist, key)]));

  mutate(root);
  await run(root, "sync");
  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const { fileKey } = await import("./manifest.js");
  const built = await buildSite({
    config: await loadConfig(root),
    incremental: true,
    stamp: { id: `sitemap-${name}`, createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");
  const after = new Map(SITEMAP_KEYS.map((key) => [key, read(dist, key)]));

  // Last, because it overwrites the tree the merge just wrote.
  const full = new Map<string, string>();
  if (compare) {
    rmSync(dist, { recursive: true, force: true });
    await run(root, "build");
    for (const key of SITEMAP_KEYS) full.set(key, read(dist, key));
  }
  return {
    dist,
    before,
    after,
    written: patch.written
      .map((file) => fileKey(file.domain, file.path))
      .filter((key) => key.endsWith(".xml"))
      .sort(),
    full,
    stats: patch.stats,
  };
}

function edit(root: string, locale: string, path: string): void {
  writeFileSync(
    join(root, "content", locale, `${path}.json`),
    `${JSON.stringify({ rev: 2, data: { title: "Edited" } })}\n`,
  );
}

test("a content-only edit carries every sitemap and composes every index", async () => {
  const one = await merge("edited", CONTENT, (root) => {
    edit(root, "en", "about");
  });

  expect(one.stats.rendered).toBeGreaterThan(0);
  expect(one.written).toEqual(INDEXES);
  for (const key of LOCALE_SITEMAPS) {
    expect(one.after.get(key)).toBe(one.before.get(key));
  }
}, 120_000);

function add(root: string, locale: string, path: string): void {
  writeFileSync(
    join(root, "content", locale, `${path}.json`),
    `${JSON.stringify({ rev: 1, data: {} })}\n`,
  );
}

test("a page added to one locale composes that locale's sitemap and carries the rest", async () => {
  const one = await merge(
    "added",
    CONTENT,
    (root) => {
      add(root, "de", "kontakt");
    },
    true,
  );

  expect(one.stats.rendered).toBe(1);
  expect(one.written).toEqual(["//example.de/sitemap-de.xml", ...INDEXES]);
  expect(
    locations(one.after.get("//example.de/sitemap-de.xml") ?? ""),
  ).toContain("https://example.de/kontakt");
  for (const key of ["/sitemap-en.xml", "/sitemap-fr.xml"]) {
    expect(one.after.get(key)).toBe(one.before.get(key));
  }
  expect(one.after).toEqual(one.full);
}, 120_000);

test("a page removed from the route table leaves the sitemap that listed it", async () => {
  const one = await merge(
    "removed",
    CONTENT,
    (root) => {
      writeFileSync(
        join(root, "content", "de", "impressum.json"),
        `${JSON.stringify({ rev: 2, deleted: true })}\n`,
      );
    },
    true,
  );

  expect(one.stats.removed).toBe(1);
  expect(one.written).toEqual(["//example.de/sitemap-de.xml", ...INDEXES]);
  expect(
    locations(one.before.get("//example.de/sitemap-de.xml") ?? ""),
  ).toContain("https://example.de/impressum");
  expect(
    locations(one.after.get("//example.de/sitemap-de.xml") ?? ""),
  ).not.toContain("https://example.de/impressum");
  for (const key of ["/sitemap-en.xml", "/sitemap-fr.xml"]) {
    expect(one.after.get(key)).toBe(one.before.get(key));
  }
  expect(one.after).toEqual(one.full);
}, 120_000);

test("a page added at a path other locales hold composes every one of their sitemaps", async () => {
  const one = await merge(
    "widened",
    CONTENT,
    (root) => {
      add(root, "de", "about");
    },
    true,
  );

  expect(one.written).toEqual([...SITEMAP_KEYS]);
  for (const key of ["/sitemap-en.xml", "/sitemap-fr.xml"]) {
    expect(one.after.get(key)).not.toBe(one.before.get(key));
    expect(one.after.get(key)).toContain(
      'hreflang="de" href="https://example.de/about"',
    );
  }
  expect(one.after).toEqual(one.full);
}, 120_000);

test("a sitemap the tree lost or that was edited under it is composed again", async () => {
  const one = await merge("reread", CONTENT, (root) => {
    edit(root, "en", "about");
    const dist = join(root, "dist");
    rmSync(join(dist, "sitemap-en.xml"));
    writeFileSync(join(dist, "sitemap-fr.xml"), "<!-- edited -->\n");
  });

  expect(one.written).toEqual([
    "//example.de/sitemap.xml",
    "/sitemap-en.xml",
    "/sitemap-fr.xml",
    "/sitemap.xml",
  ]);
  for (const key of ["/sitemap-en.xml", "/sitemap-fr.xml"]) {
    expect(one.after.get(key)).toBe(one.before.get(key));
  }
  expect(one.after.get("//example.de/sitemap-de.xml")).toBe(
    one.before.get("//example.de/sitemap-de.xml"),
  );
}, 120_000);

test("a locale whose pages re-rendered for a content reason still recomposes when another locale joins one of its paths", async () => {
  const one = await merge(
    "joined",
    CONTENT,
    (root) => {
      edit(root, "en", "about");
      add(root, "de", "about");
    },
    true,
  );

  expect(one.written).toEqual([...SITEMAP_KEYS]);
  for (const key of ["/sitemap-en.xml", "/sitemap-fr.xml"]) {
    expect(one.before.get(key)).not.toContain(
      'hreflang="de" href="https://example.de/about"',
    );
    expect(one.after.get(key)).toContain(
      'hreflang="de" href="https://example.de/about"',
    );
  }
  expect(one.after).toEqual(one.full);
}, 120_000);

test("a locale whose pages re-rendered for a content reason still recomposes when another locale leaves one of its paths", async () => {
  const one = await merge(
    "left",
    { ...CONTENT, de: [...(CONTENT["de"] ?? []), "about"] },
    (root) => {
      edit(root, "en", "about");
      writeFileSync(
        join(root, "content", "de", "about.json"),
        `${JSON.stringify({ rev: 2, deleted: true })}\n`,
      );
    },
    true,
  );

  expect(one.stats.removed).toBe(1);
  expect(one.written).toEqual([...SITEMAP_KEYS]);
  for (const key of ["/sitemap-en.xml", "/sitemap-fr.xml"]) {
    expect(one.before.get(key)).toContain(
      'hreflang="de" href="https://example.de/about"',
    );
    expect(one.after.get(key)).not.toContain(
      'hreflang="de" href="https://example.de/about"',
    );
  }
  expect(one.after).toEqual(one.full);
}, 120_000);

const MOVED_CONTENT: Record<string, readonly string[]> = {
  en: ["home", "pricing", "about"],
  de: ["about"],
  fr: ["home"],
};

test("a locale whose pages re-rendered for a content reason still recomposes when another locale's page at one of its paths moves", async () => {
  // Through `buildSite` and `reload`: Node caches the config module by URL, and the verb
  // never reloads it between two runs.
  const root = join(SITES, ".pagedeck-sitemap-moved-domain-test");
  merged.push(root);
  site(root, SUFFIX, MOVED_CONTENT);
  await run(root, "sync");
  await run(root, "build");
  const dist = join(root, "dist");
  const keys = ["/sitemap-en.xml", "/sitemap-fr.xml"] as const;
  const before = new Map(keys.map((key) => [key, read(dist, key)]));

  const config = join(root, "pagedeck.config.ts");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replaceAll("example.de", "example.at"),
  );
  edit(root, "en", "about");
  await run(root, "sync");
  const { loadConfig } = await import("./config.js");
  const { buildSite } = await import("./build.js");
  const { fileKey } = await import("./manifest.js");
  const built = await buildSite({
    config: await loadConfig(root, { reload: true }),
    incremental: true,
    stamp: { id: "sitemap-moved", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const patch = built.patch;
  if (patch === undefined) throw new Error("the run produced no patch");
  const written = patch.written
    .map((file) => fileKey(file.domain, file.path))
    .filter((key) => key.endsWith(".xml"))
    .sort();
  const after = new Map(keys.map((key) => [key, read(dist, key)]));

  for (const key of keys) {
    expect(written).toContain(key);
    expect(before.get(key)).toContain(
      'hreflang="de" href="https://example.de/about"',
    );
    expect(after.get(key)).toContain(
      'hreflang="de" href="https://example.at/about"',
    );
  }

  rmSync(dist, { recursive: true, force: true });
  await buildSite({
    config: await loadConfig(root, { reload: true }),
    stamp: { id: "sitemap-moved-full", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  for (const key of keys) expect(read(dist, key)).toBe(after.get(key));
}, 120_000);
