import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const ALL_SITE = join(SITES, ".pagedeck-inline-hashes-all-test");
const NONE_SITE = join(SITES, ".pagedeck-inline-hashes-none-test");
const INCREMENTAL_SITE = join(SITES, ".pagedeck-inline-hashes-incremental-test");

const CONTENT_SCRIPTS =
  '<script>window.marker = "content-3f9a"</script><script type="speculationrules">{"prefetch":[]}</script>';

// Holds a `</head>` and a whole `<script>` element inside an attribute value, neither of
// which is one: a naive reader would lose or invent hashes.
const DESCRIPTION = "Not the </head>, and not <script>window.marker = 1</script>";

const RAW_COMPONENT = `import { createElement } from "react";
export default function Raw() {
  return createElement("div", { dangerouslySetInnerHTML: { __html: ${JSON.stringify(CONTENT_SCRIPTS)} } });
}
`;

function site(root: string, declared: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Raw.js"), RAW_COMPONENT);
  for (const path of ["home", "post"]) {
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
import { defineScripts } from ${JSON.stringify(join(CORE, "scripts.ts"))};
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
    ${declared}
    head: (page) => ({
      description: ${JSON.stringify(DESCRIPTION)},
      jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: page.path },
    }),
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
          relatesTo: (entry) => [
            {
              collection: "pages",
              locale: entry.locale,
              path: entry.path === "home" ? "post" : "home",
            },
          ],
        }),
      ],
    }),
    components: {
      Raw: "./components/Raw.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Raw" }] }),
  },
});
`,
  );
  return root;
}

const THEME = 'document.documentElement.dataset.theme = "dark"';

const MOTION = 'document.documentElement.dataset.motion = "reduce"';

const SNIPPET = 'window.marker = "snippet-5e17"';

const ALL = `scripts: defineScripts({
      scripts: [
        { name: "tags", src: "https://example.com/tags.js" },
        { name: "metrics", src: "https://example.com/metrics.js", strategy: "idle" },
      ],
      runtime: ({ scripts }) => [
        ${JSON.stringify(`<script>${SNIPPET}</script>`)},
        ...scripts.map((s) => '<script type="text/partytown" src="' + s.src + '"></script>'),
      ],
    }),
    beacon: { endpoint: "https://collector.example/rum" },
    prePaint: [${JSON.stringify(THEME)}, ${JSON.stringify(MOTION)}, ${JSON.stringify(THEME)}],
    speculation: { action: "prefetch", max: 2 },`;

const NONE = `scripts: defineScripts({
      scripts: [{ name: "tags", src: "https://example.com/tags.js" }],
      runtime: () => [${JSON.stringify(`<script>${SNIPPET}</script>`)}],
    }),`;

async function run(cwd: string, ...argv: string[]): Promise<string> {
  const { runCli } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return out.join("\n");
}

interface Built {
  readonly manifest: Manifest;
  readonly documents: ReadonlyMap<string, string>;
}

const built = new Map<string, Promise<Built>>();

function build(root: string, declared: string): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, declared);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(root: string, declared: string): Promise<Built> {
  const dir = site(root, declared);
  await run(dir, "sync");
  await run(dir, "build");
  return read(join(dir, "dist"));
}

function read(dist: string): Built {
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return {
    manifest,
    documents: new Map(
      manifest.pages.map((page) => [
        page.path,
        readFileSync(join(dist, page.html), "utf8"),
      ]),
    ),
  };
}

afterAll(() => {
  for (const root of [ALL_SITE, NONE_SITE, INCREMENTAL_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function cspHash(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

interface InlineScript {
  readonly attributes: string;
  readonly text: string;
  readonly head: boolean;
}

function inlineScripts(document: string): InlineScript[] {
  expect(document.split(`content="${DESCRIPTION}"`)).toHaveLength(3);
  const html = document.replaceAll(DESCRIPTION, "");
  const headEnd = html.indexOf("</head>");
  expect(headEnd).toBeGreaterThan(0);
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !(match[1] ?? "").includes("src="))
    .map((match) => ({
      attributes: (match[1] ?? "").trim(),
      text: match[2] ?? "",
      head: (match.index ?? 0) < headEnd,
    }));
}

function coreKind(script: InlineScript): string | undefined {
  if (script.attributes === 'type="application/ld+json"') return undefined;
  if (script.text.includes("content-3f9a") || script.text === SNIPPET) {
    return undefined;
  }
  if (script.attributes === 'type="speculationrules"') {
    return script.head ? "speculation" : undefined;
  }
  expect(script.attributes).toBe("");
  if (script.text === THEME || script.text === MOTION) return "pre-paint";
  if (script.text.includes("https://collector.example/rum")) return "beacon";
  if (script.text.includes("https://example.com/metrics.js")) return "loader";
  throw new Error(`an inline script this fixture did not declare: ${script.text}`);
}

test("a page carrying all four kinds lists the hash of each, off the emitted document", async () => {
  const { manifest, documents } = await build(ALL_SITE, ALL);

  expect(manifest.pages.map((page) => page.path).sort()).toEqual([
    "/",
    "/post",
  ]);
  for (const page of manifest.pages) {
    const scripts = inlineScripts(documents.get(page.path) ?? "");
    const kinds = scripts.map(coreKind);
    expect(`${page.path}: ${kinds.join(",")}`).toBe(
      `${page.path}: pre-paint,pre-paint,pre-paint,,speculation,,,,loader,beacon`,
    );

    const core = scripts.filter((script) => coreKind(script) !== undefined);
    const expected = [...new Set(core.map((script) => cspHash(script.text)))];
    expect(page.inlineScriptHashes).toEqual(expected);
    expect(page.inlineScriptHashes).toHaveLength(5);

    for (const script of scripts) {
      expect(page.inlineScriptHashes?.includes(cspHash(script.text))).toBe(
        coreKind(script) !== undefined,
      );
    }
  }
}, 120_000);

test("two identical pre-paint snippets on one page yield one hash", async () => {
  const { manifest, documents } = await build(ALL_SITE, ALL);
  const home = manifest.pages.find((page) => page.path === "/");
  const html = documents.get("/") ?? "";

  expect(html.split(`<script>${THEME}</script>`)).toHaveLength(3);
  expect(
    home?.inlineScriptHashes?.filter((hash) => hash === cspHash(THEME)),
  ).toHaveLength(1);
  expect(home?.inlineScriptHashes?.slice(0, 2)).toEqual([
    cspHash(THEME),
    cspHash(MOTION),
  ]);
}, 120_000);

test("a page carrying none of the four has no value, whatever inline scripts the site wrote", async () => {
  const { manifest, documents } = await build(NONE_SITE, NONE);

  expect(manifest.pages).toHaveLength(2);
  for (const page of manifest.pages) {
    const html = documents.get(page.path) ?? "";
    expect(html).toContain(`<script>${SNIPPET}</script>`);
    expect(html).toContain(CONTENT_SCRIPTS);
    expect(html).toContain('<script type="application/ld+json">');
    expect(Object.hasOwn(page, "inlineScriptHashes")).toBe(false);
  }
}, 120_000);

function hashesOf(manifest: Manifest): Record<string, unknown> {
  return Object.fromEntries(
    manifest.pages.map((page) => [page.path, page.inlineScriptHashes]),
  );
}

test("an incremental build records the hashes a full build of the same store records", async () => {
  const root = site(INCREMENTAL_SITE, ALL);
  const dist = join(root, "dist");
  await run(root, "sync");
  await run(root, "build");
  const before = join(root, "dist-before");
  cpSync(dist, before, { recursive: true });

  writeFileSync(
    join(root, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 2, data: { title: "home, edited" } })}\n`,
  );
  await run(root, "sync");
  await run(root, "build");
  const full = read(dist).manifest;

  rmSync(dist, { recursive: true, force: true });
  cpSync(before, dist, { recursive: true });
  expect(await run(root, "build", "--incremental")).toContain("1 reused");
  const incremental = read(dist).manifest;

  expect(Object.keys(hashesOf(full)).sort()).toEqual(["/", "/post"]);
  for (const hashes of Object.values(hashesOf(full))) {
    expect(hashes).toHaveLength(5);
  }
  expect(hashesOf(incremental)).toEqual(hashesOf(full));
}, 360_000);
