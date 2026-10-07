import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const SITE = join(SITES, ".pagedeck-hashed-test");

/** Past Vite's 4 KiB inline limit, so the bundler emits it as a file. */
const IMAGE = Buffer.alloc(8192, 0x5a);

const EXPLICIT_PLUGIN = `{
      name: "explicit-name",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "assets/plugin-explicit.txt", source: "explicit" });
        this.emitFile({ type: "asset", fileName: "assets/logo.png", name: "logo.png", source: "fixed" });
      },
    }`;

const STUB_FONTS = `fonts: {
      adapter: {
        name: "stub-subsetter",
        subset: (request) => ({
          bytes: new TextEncoder().encode("wOF2:" + request.family),
          metrics: { unitsPerEm: 1000, ascent: 950, descent: 250, lineGap: 0, xHeight: 520 },
        }),
      },
      faces: [
        { family: "Acme Sans", src: "./fonts/acme-sans.ttf", weight: 400, style: "normal", display: "swap", unicodeRanges: ["U+0000-00FF"], fallback: ["Georgia"] },
      ],
    },`;

function site(root: string): string {
  rmSync(root, { recursive: true, force: true });
  const write = (path: string, contents: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write("components/logo.png", IMAGE);
  write(
    "components/Hero.js",
    // `new URL` rather than an import, so the server render reads a URL and
    // the bundler still emits the image as a file of its own.
    `const logo = new URL("./logo.png", import.meta.url).href;\nexport default function Hero() { return "marker-hero-5601" + logo; }\n`,
  );
  write("components/theme.css", "body { color: rebeccapurple; }\n");
  write("fonts/acme-sans.ttf", "not a real font, only its presence matters");
  write("public/assets/lunr-language.js", "export const language = 'en';\n");
  write("content/en/home.json", `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`);
  write(
    "pagedeck.config.ts",
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: () => "landing",
    byTemplate: { landing: [{ component: "Hero", count: 1, foldScore: 0, depth: 0, isRoot: true }] },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${STUB_FONTS}
    css: ["./components/theme.css"],
    passthrough: { root: "./public" },
    vite: { plugins: [${EXPLICIT_PLUGIN}] },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
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

async function ok(cwd: string, ...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, { cwd, env: {}, out: () => undefined, err: (line) => err.push(line) });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

let manifest: Promise<Manifest> | undefined;
function built(): Promise<Manifest> {
  manifest ??= (async () => {
    const dir = site(SITE);
    await ok(dir, "sync");
    await ok(dir, "build");
    const file = join(dir, "dist", "manifest.json");
    return readManifest(readFileSync(file, "utf8"), file);
  })();
  return manifest;
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("every file the build named from its bytes carries hashed, and no other file does", async () => {
  const { files } = await built();
  const hashed = files.filter((file) => file.hashed === true).map((file) => file.path).sort();
  const plain = files.filter((file) => file.hashed === undefined).map((file) => file.path).sort();

  const one = (pattern: RegExp): string => {
    const matches = files.map((file) => file.path).filter((path) => pattern.test(path));
    expect(matches, String(pattern)).toHaveLength(1);
    return matches[0] ?? "";
  };
  const chunks = files.filter((file) => file.kind === "js" && file.path.startsWith("/assets/"));
  expect(chunks.length).toBeGreaterThan(0);

  expect(hashed).toEqual(
    [
      ...chunks.map((file) => file.path),
      one(/^\/assets\/[^/]+\.css$/),
      one(/^\/assets\/logo-[^/]+\.png$/),
      one(/^\/fonts\/acme-sans-400-normal\.[0-9a-f]{8}\.woff2$/),
      one(/^\/fonts\/fonts\.[0-9a-f]{8}\.css$/),
    ].sort(),
  );
  expect(plain).toContain("/index.html");
  expect(plain).toContain("/assets/lunr-language.js");
  expect(plain).toContain("/assets/plugin-explicit.txt");
  expect(plain).toContain("/assets/logo.png");
  expect(files.every((file) => file.hashed === true || file.hashed === undefined)).toBe(true);
}, 120_000);
