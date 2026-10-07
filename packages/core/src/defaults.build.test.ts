import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const SPELLED_OUT = join(SITES, ".pagedeck-defaults-spelled-out-test");
const DEFAULTED = join(SITES, ".pagedeck-defaults-defaulted-test");

const ENTRIES = ["index", "about", "legal/terms", "guide/index"];

const imports = (root: string): string => `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

const components = { Path: "./components/Path.js" };
const content = (page) => ({ tree: [{ component: "Path", props: { path: page.path } }] });
`;

const EXPLICIT = `
export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./site",
    pages: definePages({
      trailingSlash: "always",
      locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => {
            const parts = entry.path.split("/");
            if (parts.at(-1) !== "index") return parts;
            return parts.length === 1 ? "/" : parts.slice(0, -1);
          },
        }),
      ],
    }),
    components,
    content,
  },
});
`;

const MINIMAL = `
export default defineConfig({
  collections: [pages],
  build: { pages: [fromCollection(pages)], components, content },
});
`;

function writeSite(root: string, config: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(
    join(root, "components", "Path.js"),
    `export default function Path({ path }) { return path; }\n`,
  );
  for (const path of ENTRIES) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { path } })}\n`);
  }
  writeFileSync(join(root, "pagedeck.config.ts"), `${imports(root)}${config}`);
}

async function run(cwd: string, ...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

afterAll(() => {
  rmSync(SPELLED_OUT, { recursive: true, force: true });
  rmSync(DEFAULTED, { recursive: true, force: true });
});

test("a config omitting store, outDir, locales, trailingSlash and route builds the site one spelling them out builds", async () => {
  for (const [root, config] of [
    [SPELLED_OUT, EXPLICIT],
    [DEFAULTED, MINIMAL],
  ] as const) {
    writeSite(root, config);
    await run(root, "sync");
    await run(root, "build");
  }

  expect(existsSync(join(DEFAULTED, "content.db"))).toBe(true);
  const spelledOut = join(SPELLED_OUT, "site");
  expect(diffOutputTrees(spelledOut, join(DEFAULTED, "site"))).toEqual([]);
  for (const file of ["index.html", "about/index.html", "legal/terms/index.html", "guide/index.html"]) {
    expect(existsSync(join(spelledOut, file)), file).toBe(true);
  }
}, 120_000);
