import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const PLAIN_SITE = join(SITES, ".pagedeck-favicon-plain-test");
const ICON_SITE = join(SITES, ".pagedeck-favicon-declared-test");
const TREES_SITE = join(SITES, ".pagedeck-favicon-trees-test");
const MISSING_SITE = join(SITES, ".pagedeck-favicon-missing-test");
const PASSTHROUGH_SITE = join(SITES, ".pagedeck-favicon-passthrough-test");

const ONE_TREE = `en: { label: "English", direction: "ltr" },`;
const TWO_TREES = `en: { label: "English", direction: "ltr", domain: "example.com" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },`;

const ICON = Uint8Array.from([0, 0, 1, 0, 0x32, 0x39, 0x37]);

const COMPONENT = `export default function Copy() { return "marker-copy-297a"; }\n`;

const DECLARED = `favicon: { src: "./favicon.ico" },`;

const NO_FAVICON =
  'Favicon: this site declares no build.favicon, so no output tree has a file at /favicon.ico — a browser requests that address on its own when a page names no other icon, and the 404 it gets is logged as a console error and fails Lighthouse\'s errors-in-console audit; this is a warning and not a refusal because every page this build emitted is correct — set build.favicon to the site\'s icon file, as favicon: { src: "./favicon.ico" } (Pagedeck documentation: Favicon)';

function site(
  root: string,
  declared = "",
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  writeFileSync(join(root, "favicon.ico"), ICON);
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "public", "favicon.ico"), ICON);
  for (const locale of contentLocales) {
    const file = join(root, "content", locale, "posts", "first.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title: "First" } })}\n`);
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

async function runLines(
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; lines: string[] }> {
  const { runCli } = await import("./cli.js");
  const lines: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => lines.push(line),
  });
  return { code, lines };
}

async function runCode(
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; err: string }> {
  const { code, lines } = await runLines(cwd, ...argv);
  return { code, err: lines.join("\n") };
}

async function run(cwd: string, ...argv: string[]): Promise<string[]> {
  const { code, lines } = await runLines(cwd, ...argv);
  if (code !== EXIT_CODES.success) throw new Error(lines.join("\n"));
  return lines;
}

interface Built {
  readonly dist: string;
  readonly manifest: Manifest;
  readonly warnings: readonly string[];
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
  const warnings = await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  return {
    dist,
    manifest: readManifest(readFileSync(file, "utf8"), file),
    warnings,
  };
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    ICON_SITE,
    TREES_SITE,
    MISSING_SITE,
    PASSTHROUGH_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared favicon is emitted at /favicon.ico, byte for byte the site's file", async () => {
  const icon = await build(ICON_SITE, DECLARED);

  expect(
    Uint8Array.from(readFileSync(join(icon.dist, "favicon.ico"))),
  ).toEqual(ICON);
  expect(
    icon.manifest.files
      .filter((one) => one.path === "/favicon.ico")
      .map((one) => one.kind),
  ).toEqual(["asset"]);
}, 120_000);

test("a favicon adds one file and moves no page, because this stage writes no head element", async () => {
  const plain = await build(PLAIN_SITE);
  const icon = await build(ICON_SITE, DECLARED);

  for (const page of icon.manifest.pages) {
    expect(readFileSync(join(icon.dist, page.html.slice(1)), "utf8")).not.toContain(
      "favicon",
    );
  }

  const moved = diffOutputTrees(plain.dist, icon.dist);
  expect(moved.filter((one) => one.difference === "second-only")).toEqual([
    { path: "favicon.ico", difference: "second-only" },
  ]);
  expect(moved.filter((one) => one.difference === "first-only")).toEqual([]);
  expect(
    moved.filter((one) => one.difference === "bytes").map((one) => one.path),
  ).toEqual(["manifest.json"]);
}, 120_000);

test("every output tree gets its own icon, because a browser asks the host that served the page", async () => {
  const icon = await build(TREES_SITE, DECLARED, TWO_TREES, ["en", "de"]);

  expect(
    Uint8Array.from(readFileSync(join(icon.dist, "example.com", "favicon.ico"))),
  ).toEqual(ICON);
  expect(
    Uint8Array.from(readFileSync(join(icon.dist, "example.de", "favicon.ico"))),
  ).toEqual(ICON);
  expect(existsSync(join(icon.dist, "favicon.ico"))).toBe(false);
  expect(
    icon.manifest.files
      .filter((one) => one.path === "/favicon.ico")
      .map((one) => `${one.domain ?? ""}|${one.path}`)
      .sort(),
  ).toEqual(["example.com|/favicon.ico", "example.de|/favicon.ico"]);
}, 120_000);

test("a favicon whose source file does not exist refuses the build, naming the config and the path", async () => {
  const dir = site(MISSING_SITE, `favicon: { src: "./nowhere.ico" },`);
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain('"build.favicon" names a source file that does not exist');
  expect(err).toContain(JSON.stringify(join(dir, "nowhere.ico")));
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a site that declares no favicon is warned once that browsers will get a 404 at /favicon.ico", async () => {
  const plain = await build(PLAIN_SITE);

  expect(plain.warnings.filter((one) => one.startsWith("Favicon:"))).toEqual([
    NO_FAVICON,
  ]);
}, 120_000);

test("a site that declares a favicon is not warned about one", async () => {
  const icon = await build(ICON_SITE, DECLARED);

  expect(icon.warnings.filter((one) => one.startsWith("Favicon:"))).toEqual([]);
}, 120_000);

test("a site whose passthrough files publish /favicon.ico is not warned about one", async () => {
  const published = await build(
    PASSTHROUGH_SITE,
    `passthrough: { root: "./public" },`,
  );

  expect(existsSync(join(published.dist, "favicon.ico"))).toBe(true);
  expect(
    published.warnings.filter((one) => one.startsWith("Favicon:")),
  ).toEqual([]);
}, 120_000);
