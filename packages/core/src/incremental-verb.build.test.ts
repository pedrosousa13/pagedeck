import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { openStoreReadOnly } from "@pagedeck/content";
import { diffOutputTrees, outputDifferenceReport } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_FILE, MANIFEST_VERSION } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { VARIANT_SEGMENT } from "./routing.js";
import type { ResolvedRedirect, RoutingManifest } from "./routing.js";
import { DEFAULT_TIER_POLICY } from "./tiers.js";
import type { TierPlan } from "./tiers.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENT = `export default function Hero() { return "marker-hero-3f7a"; }\n`;

const NAV_COMPONENT = `export default function Nav() { return "marker-nav-8b2e"; }\n`;

const UNPATCHED_ADAPTER = `
    search: {
      name: "lunr",
      index: (documents) => [
        {
          path: "/search-index.json",
          kind: "asset",
          contents: JSON.stringify(documents.map((one) => [one.locale, one.path, one.html])),
        },
      ],
    },`;

function patchingAdapter(name: string): string {
  return `
    search: {
      name: ${JSON.stringify(name)},
      index: (documents) => [
        { path: "/search-index.json", kind: "asset", contents: String(documents.length) },
      ],
      patch: () => ({ written: [], pruned: [] }),
    },`;
}

const SPLIT = `
    routing: {
      experiments: [
        {
          locale: "en",
          path: "/pricing",
          cookie: "fw_pricing",
          variants: [{ name: "b", weight: 100 }],
        },
      ],
    },`;

function renderLog(root: string): string {
  return join(root, "renders.log");
}

function renders(root: string): string[] {
  const log = renderLog(root);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

function manifestOf(dist: string): Manifest {
  return JSON.parse(
    readFileSync(join(dist, MANIFEST_FILE), "utf8"),
  ) as Manifest;
}

function withoutCounts(plan: TierPlan): TierPlan {
  return {
    ...plan,
    pageCount: 0,
    assignments: plan.assignments.map((assignment) => ({
      ...assignment,
      pageCount: 0,
    })),
  };
}

function pageCounts(plan: TierPlan): Record<string, number> {
  return {
    plan: plan.pageCount,
    ...Object.fromEntries(
      plan.assignments.map((assignment) => [
        assignment.component,
        assignment.pageCount,
      ]),
    ),
  };
}

function shiftedCounts(plan: TierPlan, by: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(pageCounts(plan)).map(([key, count]) => [key, count + by]),
  );
}

const LEGAL_REDIRECT: ResolvedRedirect = {
  from: "/legal",
  to: "/",
  status: 308,
  source: "deleted-page",
  via: [],
};

// Appended rather than merged in `from` order, which is right only because the full
// documents hold no redirects. Each caller asserts that.
function withRedirects(
  routing: RoutingManifest,
  rows: readonly ResolvedRedirect[],
): RoutingManifest {
  return {
    ...routing,
    trees: routing.trees.map((tree) =>
      tree.domain === undefined
        ? { ...tree, redirects: [...tree.redirects, ...rows] }
        : tree,
    ),
  };
}

function edit(root: string, path: string, title: string): void {
  writeFileSync(
    join(root, "content", "en", `${path}.json`),
    `${JSON.stringify({ rev: 2, data: { title } })}\n`,
  );
}

const roots: string[] = [];

// A fresh directory per call: Node caches the config module by URL, so a reused
// path would build the first site's config.
function site(name: string, extra = "", legalNav = false): string {
  const root = join(SITES, `.pagedeck-incremental-verb-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Hero.js"), COMPONENT);
  writeFileSync(join(root, "components", "Nav.js"), NAV_COMPONENT);
  for (const [path, title] of [
    ["home", "Home"],
    ["pricing", "Pricing"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }

  writeConfig(root, extra, legalNav);
  return root;
}

// The only way to change a config between builds in this process: Node caches a
// config by URL, and a new directory is a new URL.
function rewired(from: string, name: string, extra: string): string {
  const root = join(SITES, `.pagedeck-incremental-verb-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });
  cpSync(from, root, { recursive: true });
  writeConfig(root, extra);
  return root;
}

function writeConfig(root: string, extra: string, legalNav = false): void {
  const components = legalNav
    ? `{
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
      Nav: { path: "./components/Nav.js", hydrate: "visible" },
    }`
    : `{
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
    }`;
  const tree = legalNav
    ? `page.path === "/legal" ? [{ component: "Hero" }, { component: "Nav" }] : [{ component: "Hero" }]`
    : `[{ component: "Hero" }]`;
  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { appendFileSync } from "node:fs";
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
    ${extra}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: ${components},
    tierPolicy: { minSize: 0 },
    content: (page) => {
      appendFileSync(${JSON.stringify(join(root, "renders.log"))}, page.locale + " " + page.path + "\\n");
      return { tree: ${tree} };
    },
  },
});
`,
  );
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

function previousManifest(root: string, seq: number): void {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const site = { trailingSlash: "never" } as const;
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    build: { id: "previous", createdAt: "2026-01-01T00:00:00.000Z" },
    store: { seq },
    site,
    routing: { version: 1, site, trees: [] },
    files: [],
    pages: [],
    tiers: {
      policy: DEFAULT_TIER_POLICY,
      pageCount: 0,
      shippedUsages: 0,
      groups: [],
      assignments: [],
    },
    classes: [],
  };
  writeFileSync(join(dist, MANIFEST_FILE), JSON.stringify(manifest));
}

let incremental: Promise<{ full: string; second: string; out: string }>;

function unchangedStore(): Promise<{
  full: string;
  second: string;
  out: string;
}> {
  incremental ??= (async () => {
    const root = site("unchanged");
    await ok(root, "sync");
    await ok(root, "build");
    const full = join(root, "dist-full");
    cpSync(join(root, "dist"), full, { recursive: true });
    const second = await ok(root, "build", "--incremental");
    return { full, second: join(root, "dist"), out: second.out };
  })();
  return incremental;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("an incremental build over an unchanged store emits the tree a full build emits", async () => {
  const { full, second } = await unchangedStore();

  const differences = diffOutputTrees(full, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");
}, 240_000);

test("an incremental build reports what its plan decided", async () => {
  const { out } = await unchangedStore();

  expect(out).toContain(
    "incremental: 0 of 2 pages rendered, 2 reused, 0 removed",
  );
}, 240_000);

test("an incremental build with no previous manifest is refused, naming pagedeck build", async () => {
  const root = site("no-manifest");
  await ok(root, "sync");

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("has no previous build to merge into");
  expect(result.err).toContain("run pagedeck build to write it");
}, 240_000);

test("an incremental build over a manifest of another version is refused by the version check", async () => {
  const root = site("old-version");
  await ok(root, "sync");
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, MANIFEST_FILE),
    JSON.stringify({ version: MANIFEST_VERSION - 1 }),
  );

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `is version ${String(MANIFEST_VERSION - 1)}, and this build reads version ${String(MANIFEST_VERSION)}`,
  );
  expect(result.err).toContain(
    "upgrade pagedeck, or read a manifest this version wrote",
  );
}, 240_000);

test("an incremental build over a hand-truncated manifest is refused naming each field, not a TypeError", async () => {
  const root = site("truncated");
  await ok(root, "sync");
  await ok(root, "build");
  const dist = join(root, "dist");
  const file = join(dist, MANIFEST_FILE);
  const manifest = manifestOf(dist) as unknown as {
    tiers: Record<string, unknown>;
    pages: Record<string, unknown>[];
  };
  delete manifest.tiers.groups;
  delete manifest.pages[0]?.dependencies;
  writeFileSync(file, JSON.stringify(manifest));
  const before = snapshot(dist);

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    `Manifest "${file}": 2 fields do not hold what pagedeck build writes there (pages[0].dependencies: expected a list, found nothing; tiers.groups: expected a list, found nothing), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
  );
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

test("an incremental build whose previous manifest read a store ahead of this one is refused", async () => {
  const root = site("seq-ahead");
  await ok(root, "sync");
  previousManifest(root, 9_000);

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("records store position 9000");
  expect(result.err).toContain("run pagedeck build to rebuild the whole site");
}, 240_000);

function untrustedManifest(file: string, ...lines: readonly string[]): string {
  return [
    `Manifest "${file}": pagedeck build --incremental cannot trust this document to decide which files to delete, so it wrote and deleted nothing — an incremental build deletes each file the previous build's manifest names and its own does not, and each fault below shows this document was not written by a build, so none of its rows can be trusted to choose a deletion — run pagedeck build, which builds the whole site, deletes nothing this document names, warns that it did not, and writes a manifest the next incremental build can use:`,
    ...lines.map((line) => `  ${line}`),
  ].join("\n");
}

function snapshot(dir: string, prefix = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const key = `${prefix}/${name}`;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) entries[key] = `link -> ${readlinkSync(path)}`;
    else if (stat.isDirectory()) {
      entries[key] = "directory";
      Object.assign(entries, snapshot(path, key));
    } else entries[key] = readFileSync(path, "utf8");
  }
  return entries;
}

async function incrementalOver(
  name: string,
  rows: readonly unknown[] | undefined,
  prepare: (dist: string, root: string) => void = () => undefined,
): Promise<{
  dist: string;
  file: string;
  first: number;
  sentinel: string;
  before: Record<string, string>;
  result: Run;
}> {
  const root = site(name);
  await ok(root, "sync");
  await ok(root, "build");
  const dist = join(root, "dist");
  const sentinel = join(root, "sentinel.txt");
  writeFileSync(sentinel, "outside the tree\n");
  prepare(dist, root);
  const file = join(dist, MANIFEST_FILE);
  const manifest = manifestOf(dist);
  writeFileSync(
    file,
    JSON.stringify({
      ...manifest,
      files:
        rows === undefined
          ? undefined
          : [
              ...manifest.files,
              ...rows.map((row) => ({
                kind: "asset",
                hash: "sha256:0",
                size: 0,
                ...(row as object),
              })),
            ],
    }),
  );
  const before = snapshot(dist);
  return {
    dist,
    file,
    first: manifest.files.length,
    sentinel,
    before,
    result: await run(root, "build", "--incremental"),
  };
}

test("an incremental build over a manifest whose row climbs out of the tree by its path is refused, and deletes nothing", async () => {
  const { dist, file, first, sentinel, before, result } = await incrementalOver(
    "escape-path",
    [{ path: "/../sentinel.txt" }],
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files[${String(first)}]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "/../sentinel.txt"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
  );
  expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

test("an incremental build over a manifest whose row climbs out of the tree by its domain is refused, and deletes nothing", async () => {
  const { dist, file, first, sentinel, before, result } = await incrementalOver(
    "escape-domain",
    [{ domain: "..", path: "/sentinel.txt" }],
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files[${String(first)}]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "//../sentinel.txt"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
  );
  expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

test.skipIf(process.platform === "win32")(
  "an incremental build over a manifest whose row reaches out of the tree through a symbolic link is refused, and deletes nothing",
  async () => {
    const { dist, file, first, sentinel, before, result } = await incrementalOver(
      "escape-link",
      [{ path: "/link/sentinel.txt" }],
      (tree, root) => symlinkSync(root, join(tree, "link")),
    );

    expect(result.code).toBe(EXIT_CODES.configError);
    expect(result.err).toBe(
      untrustedManifest(
        file,
        `Manifest "${file}": files row ${String(first)} names "/link/sentinel.txt", which resolves outside the output directory through a symbolic link — pagedeck build writes only paths inside it, so this row was not written by a build`,
      ),
    );
    expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
    expect(snapshot(dist)).toEqual(before);
  },
  240_000,
);

test("an incremental build over a manifest whose row names a directory is refused, and keeps it", async () => {
  const { dist, file, first, sentinel, before, result } = await incrementalOver(
    "directory-row",
    [{ path: "/kept" }, { domain: "kept", path: "" }],
    (tree) => {
      mkdirSync(join(tree, "kept"));
      writeFileSync(join(tree, "kept", "inside.txt"), "kept\n");
    },
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    untrustedManifest(
      file,
      `Manifest "${file}": files row ${String(first)} names "/kept", which is not a regular file — pagedeck build writes only regular files, so this row was not written by a build`,
      `Manifest "${file}": files row ${String(first + 1)} names "" in domain "kept", which is not a regular file — pagedeck build writes only regular files, so this row was not written by a build`,
    ),
  );
  expect(readFileSync(join(dist, "kept", "inside.txt"), "utf8")).toBe("kept\n");
  expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

test("an incremental build over a manifest whose row holds a NUL character is refused, and deletes nothing", async () => {
  const { dist, file, first, sentinel, before, result } = await incrementalOver(
    "nul-row",
    [{ path: "/stale.html" }, { path: `/x${String.fromCharCode(0)}y` }],
    (tree) => writeFileSync(join(tree, "stale.html"), "stale\n"),
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files[${String(first + 1)}]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "/x\\u0000y"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
  );
  expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

test("an incremental build over a manifest whose row names the manifest itself is refused, and keeps it", async () => {
  const { dist, file, first, sentinel, before, result } = await incrementalOver(
    "manifest-row",
    [{ path: "/manifest.json" }],
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    untrustedManifest(
      file,
      `Manifest "${file}": files row ${String(first)} names "/manifest.json", which is the manifest this build writes — pagedeck build never lists its own manifest as a file, so this row was not written by a build`,
    ),
  );
  expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

test("an incremental build over a manifest of this version with no files list is refused, and deletes nothing", async () => {
  const { dist, file, sentinel, before, result } = await incrementalOver(
    "no-files",
    undefined,
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files: expected a list, found nothing), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
  );
  expect(readFileSync(sentinel, "utf8")).toBe("outside the tree\n");
  expect(snapshot(dist)).toEqual(before);
}, 240_000);

interface EditedStore {
  root: string;
  full: string;
  second: string;
  out: string;
  // The mtime, not the bytes: a document rewritten byte for byte compares equal.
  reusedWrittenAt: number;
}

let edited: Promise<EditedStore>;

function editedStore(): Promise<EditedStore> {
  edited ??= mergedAfterEdit(site("edited", SPLIT));
  return edited;
}

function mergedAfterEdit(root: string): Promise<EditedStore> {
  return (async () => {
    const dist = join(root, "dist");
    await ok(root, "sync");
    await ok(root, "build");
    const before = join(root, "dist-before");
    cpSync(dist, before, { recursive: true });

    edit(root, "home", "Home, edited");
    await ok(root, "sync");
    rmSync(dist, { recursive: true, force: true });
    await ok(root, "build");
    const full = join(root, "dist-full");
    cpSync(dist, full, { recursive: true });

    rmSync(dist, { recursive: true, force: true });
    cpSync(before, dist, { recursive: true });
    writeFileSync(renderLog(root), "");
    const reusedWrittenAt = statSync(
      join(dist, "pricing", "index.html"),
    ).mtimeMs;
    const second = await ok(root, "build", "--incremental");
    return { root, full, second: dist, out: second.out, reusedWrittenAt };
  })();
}

test("an incremental build renders only the pages its plan names", async () => {
  const { root, out } = await editedStore();

  expect(renders(root)).toEqual(["en /"]);
  expect(out).toContain(
    "incremental: 1 of 2 pages rendered, 1 reused, 0 removed",
  );
}, 360_000);

test("an incremental build over an edited store emits the tree a full build emits", async () => {
  const { full, second } = await editedStore();

  const differences = diffOutputTrees(full, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");
}, 360_000);

test("a carried page and a re-rendered page with one entry text share one chunk, as a full build's do", async () => {
  const { root, full, second } = await editedStore();
  expect(renders(root)).toEqual(["en /"]);

  for (const dist of [full, second]) {
    const pages = manifestOf(dist).pages;
    const home = pages.find((page) => page.path === "/");
    const pricing = pages.find((page) => page.path === "/pricing");
    expect(home?.entryChunk).toBeDefined();
    expect(pricing?.entryChunk).toBe(home?.entryChunk);
    expect(existsSync(join(dist, home?.entryChunk ?? "/"))).toBe(true);
  }
  expect(manifestOf(second).pages.map((page) => page.entryChunk)).toEqual(
    manifestOf(full).pages.map((page) => page.entryChunk),
  );
}, 360_000);

let unpatched: Promise<EditedStore> | undefined;

function unpatchedStore(): Promise<EditedStore> {
  unpatched ??= mergedAfterEdit(site("unpatched", UNPATCHED_ADAPTER));
  return unpatched;
}

test("an incremental build whose search adapter has no patch renders every page, and says why", async () => {
  const { root, out } = await unpatchedStore();

  expect(renders(root)).toEqual(["en /", "en /pricing"]);
  expect(out).toContain(
    'incremental: 2 of 2 pages rendered, 0 reused, 0 removed — every page, because the "lunr" search adapter has no patch and its index is composed from every page\'s render',
  );
}, 360_000);

test("an incremental build whose search adapter has no patch emits the tree a full build emits", async () => {
  const { full, second } = await unpatchedStore();

  const differences = diffOutputTrees(full, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");
  const index = JSON.parse(
    readFileSync(join(second, "search-index.json"), "utf8"),
  ) as [string, string, string][];
  expect(index.map(([locale, path]) => `${locale} ${path}`)).toEqual([
    "en /",
    "en /pricing",
  ]);
}, 360_000);

test("an incremental build whose previous search index is missing from the tree is refused", async () => {
  const root = site("index-missing", patchingAdapter("lunr"));
  await ok(root, "sync");
  await ok(root, "build");
  rmSync(join(root, "dist", "search-index.json"));

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `Output "${join(root, "dist")}": 1 file of the "lunr" search index cannot be carried from the previous build — an incremental build hands the adapter's patch the previous index as this tree holds it, so a file this tree does not hold as that build wrote it leaves an index no build wrote to patch — run pagedeck build to write the whole index again:\n  "/search-index.json" — the tree does not hold it`,
  );
  expect(result.err).toContain("ENOENT");
}, 240_000);

test("an incremental build whose previous search index was edited on the tree is refused", async () => {
  const root = site("index-edited", patchingAdapter("lunr"));
  await ok(root, "sync");
  await ok(root, "build");
  writeFileSync(join(root, "dist", "search-index.json"), "tampered");

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    `Output "${join(root, "dist")}": 1 file of the "lunr" search index cannot be carried from the previous build — an incremental build hands the adapter's patch the previous index as this tree holds it, so a file this tree does not hold as that build wrote it leaves an index no build wrote to patch — run pagedeck build to write the whole index again:\n  "/search-index.json" — the bytes there are not the ones the previous build recorded`,
  );
}, 240_000);

async function unindexedMerge(
  name: string,
  before: string,
  after: string,
): Promise<{ full: string; second: string; out: string }> {
  const root = site(name, before);
  await ok(root, "sync");
  await ok(root, "build");

  const expected = rewired(root, `${name}-full`, after);
  rmSync(join(expected, "dist"), { recursive: true, force: true });
  await ok(expected, "build");

  const merged = rewired(root, `${name}-merged`, after);
  const second = await ok(merged, "build", "--incremental");
  return {
    full: join(expected, "dist"),
    second: join(merged, "dist"),
    out: second.out,
  };
}

test("an incremental build that declares a search adapter the previous build lacked renders every page, and emits a full build's tree", async () => {
  const { full, second, out } = await unindexedMerge(
    "index-declared",
    "",
    patchingAdapter("lunr"),
  );

  expect(out).toContain(
    'incremental: 2 of 2 pages rendered, 0 reused, 0 removed — every page, because the previous build holds no index from the "lunr" search adapter to patch',
  );
  const differences = diffOutputTrees(full, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");
  expect(readFileSync(join(second, "search-index.json"), "utf8")).toBe("2");
}, 360_000);

test("an incremental build whose search adapter was renamed renders every page, and emits a full build's tree", async () => {
  const { full, second, out } = await unindexedMerge(
    "index-renamed",
    patchingAdapter("lunr"),
    patchingAdapter("lunr-next"),
  );

  expect(out).toContain(
    'incremental: 2 of 2 pages rendered, 0 reused, 0 removed — every page, because the previous build holds no index from the "lunr-next" search adapter to patch',
  );
  const differences = diffOutputTrees(full, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");
  expect(
    manifestOf(second).files.find((file) => file.path === "/search-index.json")
      ?.search,
  ).toBe("lunr-next");
}, 360_000);

test("an incremental build mints the arms of a page it did not render", async () => {
  const { full, second } = await editedStore();

  const arm = join(second, VARIANT_SEGMENT, "b", "pricing", "index.html");
  expect(readFileSync(arm, "utf8")).toBe(
    readFileSync(join(second, "pricing", "index.html"), "utf8"),
  );

  const row = manifestOf(second).pages.find((page) => page.path === "/pricing");
  expect(row?.variants).toEqual(
    manifestOf(full).pages.find((page) => page.path === "/pricing")?.variants,
  );
}, 360_000);

test("an incremental build writes an experiment arm the tree lost", async () => {
  const root = site("missing-arm", SPLIT);
  const dist = join(root, "dist");
  await ok(root, "sync");
  await ok(root, "build");
  edit(root, "home", "Home, edited");
  await ok(root, "sync");
  const arm = join(dist, VARIANT_SEGMENT, "b", "pricing", "index.html");
  rmSync(arm);

  const result = await ok(root, "build", "--incremental");

  expect(result.out).toContain(
    "incremental: 1 of 2 pages rendered, 1 reused, 0 removed",
  );
  expect(readFileSync(arm, "utf8")).toBe(
    readFileSync(join(dist, "pricing", "index.html"), "utf8"),
  );
}, 360_000);

test("an incremental build whose reused document is missing from the tree is refused", async () => {
  const root = site("missing-document");
  await ok(root, "sync");
  await ok(root, "build");
  edit(root, "home", "Home, edited");
  await ok(root, "sync");
  rmSync(join(root, "dist", "pricing", "index.html"));

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("cannot be carried from the previous build");
  expect(result.err).toContain("the tree does not hold it");
  expect(result.err).toContain("run pagedeck build to write the whole site again");
}, 360_000);

test("an incremental build whose reused document was edited on the tree is refused", async () => {
  const root = site("edited-document");
  await ok(root, "sync");
  await ok(root, "build");
  edit(root, "home", "Home, edited");
  await ok(root, "sync");
  const document = join(root, "dist", "pricing", "index.html");
  writeFileSync(document, `${readFileSync(document, "utf8")}<!-- edited -->`);

  const result = await run(root, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("cannot be carried from the previous build");
  expect(result.err).toContain(
    "the bytes there are not the ones the previous build recorded",
  );
  expect(result.err).toContain("run pagedeck build to write the whole site again");
}, 360_000);

let twice: Promise<{ first: string; second: string; out: string }>;

function twiceIncremental(): Promise<{
  first: string;
  second: string;
  out: string;
}> {
  twice ??= (async () => {
    const root = site("twice", SPLIT);
    const dist = join(root, "dist");
    await ok(root, "sync");
    await ok(root, "build");
    await ok(root, "build", "--incremental");
    const first = join(root, "dist-first");
    cpSync(dist, first, { recursive: true });
    const second = await ok(root, "build", "--incremental");
    return { first, second: dist, out: second.out };
  })();
  return twice;
}

test("two incremental builds over one unchanged store emit one tree", async () => {
  const { first, second, out } = await twiceIncremental();

  expect(out).toContain(
    "incremental: 0 of 2 pages rendered, 2 reused, 0 removed",
  );
  const differences = diffOutputTrees(first, second);
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first, second }, differences),
  ).toBe("");
}, 360_000);

test("an experiment arm survives two consecutive incremental builds", async () => {
  const { first, second } = await twiceIncremental();

  const arm = join(VARIANT_SEGMENT, "b", "pricing", "index.html");
  expect(existsSync(join(first, arm))).toBe(true);
  expect(existsSync(join(second, arm))).toBe(true);
}, 360_000);

test("an incremental build does not rewrite a reused page's document", async () => {
  const { second, reusedWrittenAt } = await editedStore();

  expect(statSync(join(second, "pricing", "index.html")).mtimeMs).toBe(
    reusedWrittenAt,
  );
}, 360_000);

let removed: Promise<{
  before: Manifest;
  full: string;
  second: string;
  out: string;
}>;

function removedPage(): Promise<{
  before: Manifest;
  full: string;
  second: string;
  out: string;
}> {
  removed ??= removedFrom(site("removed"));
  return removed;
}

let removedAlone: ReturnType<typeof removedFrom> | undefined;

function removedAlonePage(): ReturnType<typeof removedFrom> {
  removedAlone ??= removedFrom(site("removed-alone", "", true));
  return removedAlone;
}

function removedFrom(root: string): Promise<{
  before: Manifest;
  full: string;
  second: string;
  out: string;
}> {
  return (async () => {
    const dist = join(root, "dist");
    const legal = join(root, "content", "en", "legal.json");
    writeFileSync(legal, `${JSON.stringify({ rev: 1, data: { title: "Legal" } })}\n`);
    await ok(root, "sync");
    await ok(root, "build");
    const before = manifestOf(dist);
    const kept = join(root, "dist-before");
    cpSync(dist, kept, { recursive: true });

    writeFileSync(legal, `${JSON.stringify({ rev: 2, deleted: true })}\n`);
    await ok(root, "sync");
    rmSync(dist, { recursive: true, force: true });
    await ok(root, "build");
    const full = join(root, "dist-full");
    cpSync(dist, full, { recursive: true });

    rmSync(dist, { recursive: true, force: true });
    cpSync(kept, dist, { recursive: true });
    const run = await ok(root, "build", "--incremental");
    return { before, full, second: dist, out: run.out };
  })();
}

test("an incremental build deletes a removed page's document and keeps the entry chunk its siblings still load", async () => {
  const { before, second, out } = await removedPage();

  expect(out).toContain("incremental: 0 of 2 pages rendered, 2 reused, 1 removed");
  const row = before.pages.find((page) => page.path === "/legal");
  expect(existsSync(join(second, "legal", "index.html"))).toBe(false);
  expect(
    manifestOf(second).pages.find((page) => page.path === "/legal"),
  ).toBeUndefined();
  expect(row?.entryChunk).toBeDefined();
  expect(existsSync(join(second, row?.entryChunk ?? "/"))).toBe(true);
  expect(
    manifestOf(second).pages.map((page) => page.entryChunk),
  ).toEqual([row?.entryChunk, row?.entryChunk]);
}, 360_000);

test("an incremental build deletes the entry chunk only a removed page loaded", async () => {
  const { before, full, second } = await removedAlonePage();

  const legal = before.pages.find((page) => page.path === "/legal");
  const home = before.pages.find((page) => page.path === "/");
  expect(legal?.entryChunk).toBeDefined();
  expect(legal?.entryChunk).not.toBe(home?.entryChunk);
  expect(existsSync(join(second, legal?.entryChunk ?? "/"))).toBe(false);
  expect(existsSync(join(full, legal?.entryChunk ?? "/"))).toBe(false);
  expect(existsSync(join(second, home?.entryChunk ?? "/"))).toBe(true);
}, 360_000);

test("an incremental build that removes a page redirects it to its nearest live ancestor, 308", async () => {
  const { second } = await removedPage();

  expect(
    manifestOf(second).routing.trees.map((tree) => tree.redirects),
  ).toEqual([[LEGAL_REDIRECT]]);
}, 360_000);

test("an incremental build that removes a page with no live ancestor writes no redirect", async () => {
  const root = site("removed-root");
  const home = join(root, "content", "en", "home.json");
  await ok(root, "sync");
  await ok(root, "build");

  writeFileSync(home, `${JSON.stringify({ rev: 2, deleted: true })}\n`);
  await ok(root, "sync");
  const run = await ok(root, "build", "--incremental");

  expect(run.out).toContain("1 removed");
  expect(
    manifestOf(join(root, "dist")).routing.trees.map((tree) => tree.redirects),
  ).toEqual([[]]);
}, 360_000);

test("an incremental build after the store's newest entry is deleted builds, and so does the one after it", async () => {
  const root = site("removed-newest");
  const legal = join(root, "content", "en", "legal.json");
  await ok(root, "sync");
  writeFileSync(legal, `${JSON.stringify({ rev: 1, data: { title: "Legal" } })}\n`);
  await ok(root, "sync");
  await ok(root, "build");

  const store = openStoreReadOnly(join(root, "content.db"));
  try {
    expect(store.changedSince(0).at(-1)?.path).toBe("legal");
  } finally {
    store.close();
  }

  writeFileSync(legal, `${JSON.stringify({ rev: 2, deleted: true })}\n`);
  await ok(root, "sync");
  const first = await ok(root, "build", "--incremental");
  expect(first.out).toContain(
    "incremental: 0 of 2 pages rendered, 2 reused, 1 removed",
  );
  expect(existsSync(join(root, "dist", "legal", "index.html"))).toBe(false);

  const second = await ok(root, "build", "--incremental");
  expect(second.out).toContain(
    "incremental: 0 of 2 pages rendered, 2 reused, 0 removed",
  );
}, 360_000);

test("an incremental build over a removal emits the files a full build emits", async () => {
  const { full, second } = await removedPage();

  const differences = diffOutputTrees(full, second).filter(
    (difference) => difference.path !== MANIFEST_FILE,
  );
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");

  const { build: _stamp, tiers, routing, ...rest } = manifestOf(second);
  const {
    build: _fullStamp,
    tiers: fullTiers,
    routing: fullRouting,
    ...fullRest
  } = manifestOf(full);
  expect(rest).toEqual(fullRest);
  expect(fullRouting.trees.flatMap((tree) => tree.redirects)).toEqual([]);
  expect(routing).toEqual(withRedirects(fullRouting, [LEGAL_REDIRECT]));
  expect(withoutCounts(tiers)).toEqual(withoutCounts(fullTiers));
  expect(pageCounts(tiers)).toEqual(shiftedCounts(fullTiers, 1));
  expect(pageCounts(tiers)).toEqual({ plan: 3, Hero: 3 });
}, 360_000);

function localeSite(name: string): string {
  const root = join(SITES, `.pagedeck-incremental-verb-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Hero.js"), COMPONENT);
  for (const { locale, path, title } of [
    { locale: "en", path: "home", title: "Home" },
    { locale: "en", path: "pricing", title: "Pricing" },
    { locale: "fr", path: "home", title: "Accueil" },
    { locale: "fr", path: "pricing", title: "Tarifs" },
    { locale: "fr", path: "new", title: "Nouveau" },
  ]) {
    const file = join(root, "content", locale, `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { appendFileSync } from "node:fs";
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
    origin: "https://example.test",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "en", direction: "ltr" },
        fr: { label: "fr", direction: "ltr" },
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
    content: (page) => {
      appendFileSync(${JSON.stringify(join(root, "renders.log"))}, page.locale + " " + page.path + "\\n");
      return { tree: [{ component: "Hero" }] };
    },
  },
});
`,
  );
  return root;
}

function addEntry(
  root: string,
  locale: string,
  path: string,
  title: string,
): void {
  writeFileSync(
    join(root, "content", locale, `${path}.json`),
    `${JSON.stringify({ rev: 1, data: { title } })}\n`,
  );
}

let sibling: Promise<{ root: string; full: string; second: string }>;

function addedSibling(): Promise<{
  root: string;
  full: string;
  second: string;
}> {
  sibling ??= (async () => {
    const root = localeSite("sibling");
    const dist = join(root, "dist");
    await ok(root, "sync");
    await ok(root, "build");
    const before = join(root, "dist-before");
    cpSync(dist, before, { recursive: true });

    addEntry(root, "en", "new", "New");
    await ok(root, "sync");
    rmSync(dist, { recursive: true, force: true });
    await ok(root, "build");
    const full = join(root, "dist-full");
    cpSync(dist, full, { recursive: true });

    rmSync(dist, { recursive: true, force: true });
    cpSync(before, dist, { recursive: true });
    writeFileSync(renderLog(root), "");
    await ok(root, "build", "--incremental");
    return { root, full, second: dist };
  })();
  return sibling;
}

test("an incremental build that adds a locale's page emits the tree a full build emits", async () => {
  const { full, second } = await addedSibling();

  const differences = diffOutputTrees(full, second).filter(
    (difference) => difference.path !== MANIFEST_FILE,
  );
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");

  const { build: _stamp, tiers, ...rest } = manifestOf(second);
  const {
    build: _fullStamp,
    tiers: fullTiers,
    ...fullRest
  } = manifestOf(full);
  expect(rest).toEqual(fullRest);
  expect(withoutCounts(tiers)).toEqual(withoutCounts(fullTiers));
  expect(pageCounts(tiers)).toEqual(shiftedCounts(fullTiers, -1));
  expect(pageCounts(tiers)).toEqual({ plan: 5, Hero: 5 });
}, 360_000);

test("an incremental build widened by a new sibling still reuses the pages whose group did not move", async () => {
  const { root } = await addedSibling();

  expect(renders(root)).toEqual(["en /new", "fr /new"]);
}, 360_000);

function speculationSite(name: string): string {
  const root = join(SITES, `.pagedeck-incremental-verb-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Hero.js"), COMPONENT);
  for (const [path, title] of [
    ["home", "Home"],
    ["pricing", "Pricing"],
    ["legal", "Legal"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { appendFileSync } from "node:fs";
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
    speculation: { action: "prefetch", max: 5 },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
          relatesTo: (entry) =>
            entry.path === "home"
              ? [{ collection: "pages", locale: "en", path: "legal" }]
              : [],
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: (page) => {
      appendFileSync(${JSON.stringify(join(root, "renders.log"))}, page.locale + " " + page.path + "\\n");
      return { tree: [{ component: "Hero" }] };
    },
  },
});
`,
  );
  return root;
}

let brokenRelation: Promise<{ root: string; full: string; second: string }>;

function removedRelationTarget(): Promise<{
  root: string;
  full: string;
  second: string;
}> {
  brokenRelation ??= (async () => {
    const root = speculationSite("relation");
    const dist = join(root, "dist");
    await ok(root, "sync");
    await ok(root, "build");
    const before = join(root, "dist-before");
    cpSync(dist, before, { recursive: true });

    writeFileSync(
      join(root, "content", "en", "legal.json"),
      `${JSON.stringify({ rev: 2, deleted: true })}\n`,
    );
    await ok(root, "sync");
    rmSync(dist, { recursive: true, force: true });
    await ok(root, "build");
    const full = join(root, "dist-full");
    cpSync(dist, full, { recursive: true });

    rmSync(dist, { recursive: true, force: true });
    cpSync(before, dist, { recursive: true });
    writeFileSync(renderLog(root), "");
    await ok(root, "build", "--incremental");
    return { root, full, second: dist };
  })();
  return brokenRelation;
}

test("an incremental build over a removal that breaks a relation emits the tree a full build emits", async () => {
  const { full, second } = await removedRelationTarget();

  const differences = diffOutputTrees(full, second).filter(
    (difference) => difference.path !== MANIFEST_FILE,
  );
  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport({ first: full, second }, differences),
  ).toBe("");

  const { build: _stamp, tiers, routing, ...rest } = manifestOf(second);
  const {
    build: _fullStamp,
    tiers: fullTiers,
    routing: fullRouting,
    ...fullRest
  } = manifestOf(full);
  expect(rest).toEqual(fullRest);
  expect(fullRouting.trees.flatMap((tree) => tree.redirects)).toEqual([]);
  expect(routing).toEqual(withRedirects(fullRouting, [LEGAL_REDIRECT]));
  expect(withoutCounts(tiers)).toEqual(withoutCounts(fullTiers));
  expect(pageCounts(tiers)).toEqual(shiftedCounts(fullTiers, 1));
  expect(pageCounts(tiers)).toEqual({ plan: 3, Hero: 3 });
}, 360_000);

test("an incremental build widened by a broken relation still reuses the page that named none", async () => {
  const { root } = await removedRelationTarget();

  expect(renders(root)).toEqual(["en /"]);
}, 360_000);

function scheduledSite(name: string): string {
  const root = join(SITES, `.pagedeck-incremental-verb-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Hero.js"), COMPONENT);
  for (const [path, title] of [
    ["home", "Home"],
    ["pricing", "Pricing"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }
  // Dated in the past: a fixture dated relative to now measures the calendar.
  // `rewind` moves the previous build's instant instead.
  const announcement = join(root, "posts", "en", "announcement.json");
  mkdirSync(dirname(announcement), { recursive: true });
  writeFileSync(
    announcement,
    `${JSON.stringify({
      rev: 1,
      data: { title: "Announcement", publish_at: "2020-01-01T00:00:00Z" },
    })}\n`,
  );

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { appendFileSync } from "node:fs";
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

const posts = {
  name: "posts",
  loader: createFixtureLoader(${JSON.stringify(join(root, "posts"))}),
  schema: false,
  publishField: "publish_at",
};

export default defineConfig({
  store: "./content.db",
  collections: [pages, posts],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
          dependsOn: (entry) =>
            entry.path === "home"
              ? [{ collection: "posts", locale: "en", path: "announcement" }]
              : [],
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: (page) => {
      appendFileSync(${JSON.stringify(join(root, "renders.log"))}, page.locale + " " + page.path + "\\n");
      return { tree: [{ component: "Hero" }] };
    },
  },
});
`,
  );
  return root;
}

function rewind(dist: string, createdAt: string): void {
  const manifest = manifestOf(dist);
  writeFileSync(
    join(dist, MANIFEST_FILE),
    JSON.stringify({
      ...manifest,
      build: { ...manifest.build, createdAt },
    }),
  );
}

test("an incremental build re-renders the page that reads an entry that became due", async () => {
  const root = scheduledSite("due");
  const dist = join(root, "dist");
  await ok(root, "sync");
  await ok(root, "build");

  rewind(dist, "2000-01-01T00:00:00Z");
  writeFileSync(renderLog(root), "");
  const second = await ok(root, "build", "--incremental");

  expect(renders(root)).toEqual(["en /"]);
  expect(second.out).toContain(
    "incremental: 1 of 2 pages rendered, 1 reused, 0 removed",
  );
}, 360_000);
