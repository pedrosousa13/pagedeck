import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const SITEMAP_SITE = join(SITES, ".pagedeck-path-collision-sitemap-test");
const NEVER_SITE = join(SITES, ".pagedeck-path-collision-never-test");

function site(
  root: string,
  paths: readonly string[],
  trailingSlash: "always" | "never",
): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(
    join(root, "components", "Copy.js"),
    `export default function Copy() { return "marker-copy-622"; }\n`,
  );
  mkdirSync(join(root, "content", "en"), { recursive: true });
  for (const path of paths) {
    writeFileSync(
      join(root, "content", "en", `${path}.json`),
      `${JSON.stringify({ rev: 1, data: {} })}\n`,
    );
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
    origin: "https://example.com",
    sitemap: { pattern: "suffix" },
    pages: definePages({
      trailingSlash: ${JSON.stringify(trailingSlash)},
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
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
    content: () => ({ tree: [{ component: "Copy" }] }),
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

afterAll(() => {
  rmSync(SITEMAP_SITE, { recursive: true, force: true });
  rmSync(NEVER_SITE, { recursive: true, force: true });
});

test('under "always", a page at /sitemap.xml/ beside the emitted sitemap refuses the build and writes nothing', async () => {
  const dir = site(SITEMAP_SITE, ["home", "sitemap.xml"], "always");
  const sync = await runCode(dir, "sync");
  if (sync.code !== EXIT_CODES.success) throw new Error(sync.err);

  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    "Site build: 1 page document collides with a file this build emits into the same tree",
  );
  expect(err).toContain(
    '  en /sitemap.xml/ — its document "/sitemap.xml/index.html" needs "/sitemap.xml" as a directory, where the build emits an asset file',
  );
  expect(err).not.toMatch(/EISDIR|ENOTDIR/);
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test('under "never", a page at /sitemap.xml refuses the build the same way, because its document is /sitemap.xml/index.html under every policy', async () => {
  const dir = site(NEVER_SITE, ["home", "sitemap.xml"], "never");
  const sync = await runCode(dir, "sync");
  if (sync.code !== EXIT_CODES.success) throw new Error(sync.err);

  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain(
    "Site build: 1 page document collides with a file this build emits into the same tree",
  );
  expect(err).toContain(
    '  en /sitemap.xml — its document "/sitemap.xml/index.html" needs "/sitemap.xml" as a directory, where the build emits an asset file',
  );
  expect(err).not.toMatch(/EISDIR|ENOTDIR/);
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);
