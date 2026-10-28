import {
  mkdirSync,
  readFileSync,
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

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const LINKED_SITE = join(SITES, ".pagedeck-css-symlink-linked-test");
const REAL_SITE = join(SITES, ".pagedeck-css-symlink-real-test");
const MISSING_SITE = join(SITES, ".pagedeck-css-symlink-missing-test");

const GLOBAL_RULE = ".fw-brand";

// The layout pnpm gives a workspace package: the sheet's real home, and a
// `node_modules` link to it.
function site(root: string, css: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "packages", "brand"), { recursive: true });
  writeFileSync(
    join(root, "packages", "brand", "brand.css"),
    `${GLOBAL_RULE} { color: rgb(31, 32, 33); }\n`,
  );
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync("../packages/brand", join(root, "node_modules", "brand"), "dir");

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(
    join(root, "components", "Hero.js"),
    `export default function Hero() { return "marker-hero-61d0"; }\n`,
  );
  writeFileSync(
    join(root, "components", "Copy.js"),
    `export default function Copy() { return "marker-copy-0e7a"; }\n`,
  );
  for (const path of ["home", "pricing", "about"]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title: path } })}\n`);
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
    css: [${JSON.stringify(css)}],
    criticalCss: { "/pricing": true },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "load" },
      Copy: "./components/Copy.js",
    },
    content: (page) => ({
      tree: page.path === "/" ? [{ component: "Hero" }] : [{ component: "Copy" }],
    }),
  },
});
`,
  );
  return root;
}

afterAll(() => {
  rmSync(LINKED_SITE, { recursive: true, force: true });
  rmSync(REAL_SITE, { recursive: true, force: true });
  rmSync(MISSING_SITE, { recursive: true, force: true });
});

async function run(cwd: string, ...argv: string[]): Promise<string[]> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return err;
}

const built = new Map<string, Promise<Map<string, string>>>();

function build(root: string, css: string): Promise<Map<string, string>> {
  let one = built.get(root);
  if (one === undefined) {
    one = (async () => {
      site(root, css);
      await run(root, "sync");
      await run(root, "build");
      const file = join(root, "dist", "manifest.json");
      const manifest = readManifest(readFileSync(file, "utf8"), file);
      return new Map(
        manifest.pages.map((page) => [
          page.path,
          readFileSync(join(root, "dist", page.html), "utf8"),
        ]),
      );
    })();
    built.set(root, one);
  }
  return one;
}

const buildLinked = () =>
  build(LINKED_SITE, "./node_modules/brand/brand.css");
const buildReal = () => build(REAL_SITE, "./packages/brand/brand.css");

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map(
    (match) => /\bhref="([^"]*)"/.exec(match[0])?.[1] ?? "",
  );
}

test.each([
  ["with an island", "/"],
  ["without an island", "/about"],
])(
  "a page %s links one sheet holding a build.css sheet listed through a symbolic link",
  async (_, path) => {
    const htmlOf = await buildLinked();

    const hrefs = hrefsOf(htmlOf.get(path) ?? "");
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toMatch(/^\/assets\/pagedeck-core-[\w-]+\.css$/);
    expect(
      readFileSync(join(LINKED_SITE, "dist", hrefs[0] as string), "utf8"),
    ).toContain(GLOBAL_RULE);
  },
  120_000,
);

test("a flagged page without an island inlines a build.css sheet listed through a symbolic link", async () => {
  const htmlOf = await buildLinked();

  const html = htmlOf.get("/pricing") ?? "";
  expect(hrefsOf(html)).toEqual([]);
  expect(html).toMatch(new RegExp(`<style[^>]*>[^<]*\\${GLOBAL_RULE}`));
}, 120_000);

test("a build.css sheet listed through a symbolic link builds what its real path builds", async () => {
  await Promise.all([buildLinked(), buildReal()]);

  expect(
    diffOutputTrees(join(LINKED_SITE, "dist"), join(REAL_SITE, "dist")),
  ).toEqual([]);
}, 240_000);

test("a build.css entry naming no file fails the build", async () => {
  site(MISSING_SITE, "./node_modules/brand/absent.css");
  await run(MISSING_SITE, "sync");

  await expect(run(MISSING_SITE, "build")).rejects.toThrow(
    `Could not resolve '${join(MISSING_SITE, "node_modules", "brand", "absent.css")}'`,
  );
}, 120_000);
