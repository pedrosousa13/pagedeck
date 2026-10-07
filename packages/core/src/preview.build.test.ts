import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
const PREVIEW_PACKAGE = join(CORE, "..", "..", "preview");

const PLAIN_SITE = join(SITES, ".pagedeck-preview-plain-test");
const PREVIEW_SITE = join(SITES, ".pagedeck-preview-declared-test");
const TREES_SITE = join(SITES, ".pagedeck-preview-trees-test");
const TWICE_SITE = join(SITES, ".pagedeck-preview-twice-test");
const TWICE_AGAIN = join(SITES, ".pagedeck-preview-twice-again-test");

const ONE_TREE = `en: { label: "English", direction: "ltr" },`;
const TWO_TREES = `en: { label: "English", direction: "ltr", domain: "example.com" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },`;

// An island: a site with none has no client build, so the production-bytes check
// would hold vacuously.
const COMPONENT = `"use client";
export default function Copy() { return "marker-copy-382a"; }
`;

const PREVIEW = `preview: { path: "/_preview" },`;


function site(
  root: string,
  declared = "",
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  // The generated entry imports `@pagedeck/preview` by bare specifier, and `@pagedeck/core` must
  // not depend on it.
  mkdirSync(join(root, "node_modules", "@pagedeck"), { recursive: true });
  symlinkSync(PREVIEW_PACKAGE, join(root, "node_modules", "@pagedeck", "preview"));
  for (const locale of contentLocales) {
    const file = join(root, "content", locale, "posts", "first.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ rev: 1, data: { title: "First" } })}\n`,
    );
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
      sources: [fromCollection(posts)],
    }),
    components: { Copy: "./components/Copy.js" },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
  return root;
}

interface Ran {
  readonly out: readonly string[];
}

async function run(cwd: string, ...argv: string[]): Promise<Ran> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const out: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return { out };
}

interface Built {
  readonly dist: string;
  readonly manifest: Manifest;
  readonly out: readonly string[];
}

const built = new Map<string, Promise<Built>>();

function build(
  root: string,
  declared = "",
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, declared, locales, contentLocales);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  declared: string,
  locales: string,
  contentLocales: readonly string[],
): Promise<Built> {
  const dir = site(root, declared, locales, contentLocales);
  await run(dir, "sync");
  const { out } = await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  return {
    dist,
    manifest: readManifest(readFileSync(file, "utf8"), file),
    out,
  };
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    PREVIEW_SITE,
    TREES_SITE,
    TWICE_SITE,
    TWICE_AGAIN,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function read(dist: string, path: string): string {
  return readFileSync(join(dist, path), "utf8");
}

function walk(dir: string, prefix = ""): readonly string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

function previewFiles(dist: string): readonly string[] {
  return walk(dist).filter((path) => path.startsWith("_preview/"));
}

function scriptSrc(document: string): string {
  return /<script type="module" src="([^"]+)"><\/script>/.exec(document)?.[1] ?? "";
}

test("a declared preview is emitted, and its script names a chunk this build wrote", async () => {
  const preview = await build(PREVIEW_SITE, PREVIEW);
  const document = read(preview.dist, join("_preview", "index.html"));

  expect(document).toContain('<div id="fw-preview"></div>');
  const src = scriptSrc(document);
  expect(src).toMatch(/^\/_preview\/assets\/preview-[^/]+\.js$/);
  expect(read(preview.dist, src.slice(1))).toContain("fw-preview-build-target");
  expect(
    previewFiles(preview.dist).some((path) =>
      readFileSync(join(preview.dist, path), "utf8").includes(
        "marker-copy-382a",
      ),
    ),
  ).toBe(true);

  expect(
    preview.manifest.files.find((one) => one.path === "/_preview/index.html")
      ?.kind,
  ).toBe("html");
}, 180_000);

test("the build says on its way past that the app authenticates nothing", async () => {
  const preview = await build(PREVIEW_SITE, PREVIEW);

  const line = preview.out.find((one) => one.startsWith("preview:"));
  expect(line).toBe(
    "preview: /_preview — this app authenticates nothing and renders any draft posted to it; put the deployment behind whatever the drafts need (Pagedeck documentation: Preview app, Security)",
  );
}, 180_000);

test("a site that declares no preview gets none, and declaring one adds only that subtree", async () => {
  const plain = await build(PLAIN_SITE);
  const preview = await build(PREVIEW_SITE, PREVIEW);

  expect(existsSync(join(plain.dist, "_preview"))).toBe(false);
  expect(
    plain.manifest.files.some((one) => one.path.startsWith("/_preview/")),
  ).toBe(false);

  const moved = diffOutputTrees(plain.dist, preview.dist);
  const added = moved
    .filter((one) => one.difference === "second-only")
    .map((one) => one.path);
  expect(added.length).toBeGreaterThan(1);
  expect(added.every((path) => path.startsWith("_preview/"))).toBe(true);
  expect(moved.filter((one) => one.difference === "first-only")).toEqual([]);
  expect(
    moved.filter((one) => one.difference === "bytes").map((one) => one.path),
  ).toEqual(["manifest.json"]);
}, 180_000);

test("nothing the build wrote outside the preview path carries the app's mark", async () => {
  const preview = await build(PREVIEW_SITE, PREVIEW);

  const site = walk(preview.dist).filter(
    (path) => !path.startsWith("_preview/"),
  );
  expect(site.some((path) => path.endsWith(".js"))).toBe(true);
  for (const path of site) {
    expect(readFileSync(join(preview.dist, path), "utf8")).not.toContain(
      "fw-preview-build-target",
    );
  }
  const src = scriptSrc(read(preview.dist, join("_preview", "index.html")));
  expect(read(preview.dist, src.slice(1))).toContain(
    "fw-preview-build-target",
  );
}, 180_000);

test("every output tree gets the whole app", async () => {
  const preview = await build(TREES_SITE, PREVIEW, TWO_TREES, ["en", "de"]);

  expect(existsSync(join(preview.dist, "_preview"))).toBe(false);
  const trees = ["example.com", "example.de"].map((tree) => {
    const document = read(preview.dist, join(tree, "_preview", "index.html"));
    const src = scriptSrc(document);
    expect(read(preview.dist, join(tree, src.slice(1)))).toContain(
      "fw-preview-build-target",
    );
    return walk(join(preview.dist, tree)).filter((path) =>
      path.startsWith("_preview/"),
    );
  });
  expect(trees[0]).toEqual(trees[1]);
  expect(trees[0]?.length).toBeGreaterThan(1);
  expect(
    preview.manifest.files
      .filter((one) => one.path === "/_preview/index.html")
      .map((one) => `${one.domain ?? ""}|${one.path}`)
      .sort(),
  ).toEqual(["example.com|/_preview/index.html", "example.de|/_preview/index.html"]);
}, 180_000);

test("two sites with the same registry write the same preview app, byte for byte", async () => {
  const first = await build(TWICE_SITE, PREVIEW);
  const second = await build(TWICE_AGAIN, PREVIEW);

  const moved = diffOutputTrees(first.dist, second.dist)
    .filter((one) => one.path.startsWith("_preview/"));
  expect(moved).toEqual([]);
}, 180_000);
