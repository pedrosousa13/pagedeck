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

const PLAIN_SITE = join(SITES, ".pagedeck-scripts-plain-test");
const SILENT_SITE = join(SITES, ".pagedeck-scripts-silent-test");
const LOADED_SITE = join(SITES, ".pagedeck-scripts-loaded-test");
const OFF_SITE = join(SITES, ".pagedeck-scripts-off-test");
const ATTRS_SITE = join(SITES, ".pagedeck-scripts-attrs-test");
const INCREMENTAL_SITE = join(SITES, ".pagedeck-scripts-incremental-test");
const CARRIED_SITE = join(SITES, ".pagedeck-scripts-carried-test");
const EDITED_SITE = join(SITES, ".pagedeck-scripts-edited-test");
const RECOMPOSED_SITE = join(SITES, ".pagedeck-scripts-recomposed-test");

const COMPONENTS: Record<string, string> = {
  "Copy.js": `export default function Copy() { return "marker-copy-6a04"; }\n`,
};

function site(root: string, build = ""): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
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

const usage = (component) => [
  { component, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: (entry) => (entry.path === "home" ? "landing" : "article"),
    byTemplate: { landing: usage("Copy"), article: usage("Copy") },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${build}
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

const SILENT_SCRIPTS = `scripts: defineScripts({
      scripts: [
        { name: "tags", src: "https://example.com/tags.js" },
      ],
      runtime: () => [],
    }),`;

const OFF_SCRIPTS = `scripts: defineScripts({
      scripts: [
        { name: "tags", src: "https://example.com/tags.js" },
      ],
      pageTypes: { "/**": { tags: "off" } },
      runtime: ({ scripts }) => scripts.map((s) => '<script src="' + s.src + '"></script>'),
    }),`;

const LOADED_SCRIPTS = `scripts: defineScripts({
      scripts: [
        { name: "tags", src: "https://example.com/tags.js" },
        { name: "experiment", src: "https://example.com/experiment.js" },
        { name: "metrics", src: "https://example.com/metrics.js", strategy: "idle", category: "analytics" },
        { name: "chat", src: "https://example.com/chat.js", strategy: "interaction" },
        { name: "helpdesk", src: "https://example.com/helpdesk.js", strategy: "facade", facade: { html: "<button>marker-facade-9c2e</button>" } },
      ],
      pageTypes: { "/post": { experiment: "idle", chat: "off", metrics: "off" } },
      consentDefaults: { "en:/**": { analytics: "denied" } },
      runtime: ({ scripts }) => [
        '<script>marker-snippet-4b1c</script>',
        ...scripts.map((s) => '<script type="text/partytown" src="' + s.src + '"></script>'),
      ],
    }),
    prePaint: ['document.documentElement.dataset.theme = "dark" /* marker-prepaint-8e40 */'],`;

const ATTRS_SCRIPTS = `scripts: defineScripts({
      scripts: [
        { name: "analytics", src: "https://example.com/analytics.js", strategy: "idle", attributes: { "data-domain": "marker-domain-7f31.example" } },
        { name: "chat", src: "https://example.com/chat.js", strategy: "interaction" },
        { name: "comments", src: "https://example.com/comments.js", strategy: "facade", facade: { html: "<button>marker-comments-2d9a</button>" }, attributes: { "data-repo": "marker-repo-5b8c/site" } },
        { name: "widget", src: "https://example.com/widget@1.2.3.js", strategy: "idle", category: "analytics", integrity: "sha384-marker-integrity-3e7a" },
      ],
    }),`;

async function run(cwd: string, ...argv: string[]): Promise<string> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return err.join("\n");
}

const stderr = new Map<string, string>();

const manifests = new Map<string, Manifest>();

const built = new Map<string, Promise<Map<string, string>>>();

function build(root: string, scripts = ""): Promise<Map<string, string>> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, scripts);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  scripts: string,
): Promise<Map<string, string>> {
  const dir = site(root, scripts);
  await run(dir, "sync");
  stderr.set(root, await run(dir, "build"));
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  manifests.set(root, manifest);
  return new Map(
    manifest.pages.map((page) => [
      page.path,
      readFileSync(join(dist, page.html), "utf8"),
    ]),
  );
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    SILENT_SITE,
    LOADED_SITE,
    OFF_SITE,
    ATTRS_SITE,
    INCREMENTAL_SITE,
    CARRIED_SITE,
    EDITED_SITE,
    RECOMPOSED_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site that declares no script layer emits the document it always did", async () => {
  const plain = await build(PLAIN_SITE);
  const html = plain.get("/") ?? "";

  expect(html).toContain("marker-copy-6a04");
  expect(html).not.toContain("requestIdleCallback");
  expect(html).not.toContain("addEventListener");
  expect(html).not.toContain("example.com");
}, 120_000);

test("a script layer that loads nothing onto a page costs it no bytes at all", async () => {
  const plain = await build(PLAIN_SITE);
  const silent = await build(SILENT_SITE, SILENT_SCRIPTS);

  expect([...silent.keys()].sort()).toEqual([...plain.keys()].sort());
  expect(silent.size).toBeGreaterThan(0);
  for (const [path, html] of silent) {
    expect(`${path}: ${html}`).toBe(`${path}: ${plain.get(path) ?? ""}`);
  }
}, 120_000);

test("a script taken off every page costs those pages no bytes at all", async () => {
  const plain = await build(PLAIN_SITE);
  const off = await build(OFF_SITE, OFF_SCRIPTS);

  expect([...off.keys()].sort()).toEqual([...plain.keys()].sort());
  expect(off.size).toBeGreaterThan(0);
  for (const [path, html] of off) {
    expect(`${path}: ${html}`).toBe(`${path}: ${plain.get(path) ?? ""}`);
  }
}, 120_000);

test("an override takes one script off one page and leaves it on the others", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);

  expect(loaded.get("/") ?? "").toContain("https://example.com/chat.js");
  expect(loaded.get("/post") ?? "").not.toContain("https://example.com/chat.js");
}, 120_000);

test("a script declaring no strategy reaches the runtime the site configured", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  expect(html).toContain(
    '<script type="text/partytown" src="https://example.com/tags.js"></script>',
  );
  expect(html).not.toContain('load(["https://example.com/tags.js"');
}, 120_000);

test("the runtime's elements are emitted in the order it returned them", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  const snippet = html.indexOf("marker-snippet-4b1c");
  const first = html.indexOf('type="text/partytown"');
  expect(snippet).toBeGreaterThan(-1);
  expect(first).toBeGreaterThan(-1);
  expect(snippet).toBeLessThan(first);
}, 120_000);

test("explicit idle and interaction strategies are honored on the page", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  expect(html).toContain("requestIdleCallback");
  expect(html).toContain("https://example.com/metrics.js");
  expect(html).toContain("addEventListener");
  expect(html).toContain("https://example.com/chat.js");
}, 120_000);

test("a page-type override moves one script off the runtime and onto the loader", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const home = loaded.get("/") ?? "";
  const post = loaded.get("/post") ?? "";

  expect(home).toContain(
    '<script type="text/partytown" src="https://example.com/experiment.js">',
  );
  expect(post).not.toContain(
    '<script type="text/partytown" src="https://example.com/experiment.js">',
  );
  expect(post).toContain("https://example.com/experiment.js");
  expect(post).toContain(
    '<script type="text/partytown" src="https://example.com/tags.js">',
  );
}, 120_000);

test("a facade's placeholder is markup in the document, and its script is not", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  expect(html).toMatch(
    /<div data-fw-facade="[0-9a-f]{8}-0"><button>marker-facade-9c2e<\/button><\/div>/,
  );
  expect(html).not.toContain('src="https://example.com/helpdesk.js"');
  expect(html).toContain('"https://example.com/helpdesk.js"');
}, 120_000);

test("a facade's placeholder is inside the landmark the build writes", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  const placeholder = html.indexOf('<div data-fw-facade="');
  expect(placeholder).toBeGreaterThan(-1);
  expect(placeholder).toBeLessThan(html.indexOf("</main>"));
  // The page's copy is asserted present first: `indexOf` answers -1, which orders
  // before the placeholder.
  expect(html).toContain("marker-copy-6a04");
  expect(html.indexOf("marker-copy-6a04")).toBeLessThan(placeholder);
  expect(html.indexOf("</main>")).toBeLessThan(
    html.indexOf("marker-snippet-4b1c"),
  );
}, 120_000);

test("the layer's elements are written after the document's own body", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  expect(html.indexOf("marker-copy-6a04")).toBeLessThan(
    html.indexOf("marker-snippet-4b1c"),
  );
  expect(html.indexOf("marker-snippet-4b1c")).toBeLessThan(
    html.indexOf("</body>"),
  );
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).not.toContain("example.com");
}, 120_000);

test("a pre-paint script is in the head, ahead of everything the layer emits", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain("marker-prepaint-8e40");
  expect(html.indexOf("marker-prepaint-8e40")).toBeLessThan(
    html.indexOf("marker-snippet-4b1c"),
  );
  expect(html.indexOf("marker-prepaint-8e40")).toBeLessThan(
    html.indexOf("https://example.com/metrics.js"),
  );
  expect(head).toContain(
    '<script>document.documentElement.dataset.theme = "dark" /* marker-prepaint-8e40 */</script>',
  );
}, 120_000);

test("a consent category survives the config loader and reaches the page as a gate", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const html = loaded.get("/") ?? "";

  expect(html).toContain('[["https://example.com/metrics.js","analytics",0]]');
  expect(html).toContain('window["fwConsent"]');
  expect(html).toContain('"fw:consent"');
  expect(html).toContain('load(["https://example.com/chat.js"])');
}, 120_000);

test("a page that keeps a script and loses a gated one carries a consent-free loader", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const post = loaded.get("/post") ?? "";

  expect(post).toContain("requestIdleCallback");
  expect(post).toContain("https://example.com/experiment.js");
  expect(post).not.toContain("https://example.com/metrics.js");
  expect(post).not.toContain("fwConsent");
  expect(post).not.toContain("fw:consent");
}, 120_000);

test("a script no page loads is reported on the build's own stderr", async () => {
  await build(OFF_SITE, OFF_SCRIPTS);
  const err = stderr.get(OFF_SITE) ?? "";

  expect(err).toContain(
    'Script reach: 1 script resolves to "off" on every page this site builds, so no page loads it',
  );
  expect(err).toContain("this site builds 2 pages");
  expect(err).toContain('  "tags" — pageTypes "/**" sets "off"');
}, 120_000);

test("a script one page keeps is not reported as one no page loads", async () => {
  await build(LOADED_SITE, LOADED_SCRIPTS);

  expect(stderr.get(LOADED_SITE) ?? "").not.toContain("Script reach:");
}, 120_000);

test("a declared data attribute survives the config loader and reaches the page", async () => {
  const attrs = await build(ATTRS_SITE, ATTRS_SCRIPTS);
  const html = attrs.get("/") ?? "";

  expect(html).toContain(
    'load([["https://example.com/analytics.js","data-domain","marker-domain-7f31.example"]])',
  );
  expect(html).toContain('load([["https://example.com/chat.js"]])');
}, 120_000);

test("the built loader writes the attributes onto the element before appending it", async () => {
  const attrs = await build(ATTRS_SITE, ATTRS_SCRIPTS);
  const html = attrs.get("/") ?? "";

  expect(html).toContain(
    "for(var a=1;a<t.length;a+=2)s.setAttribute(t[a],t[a+1]);s.async=true;document.head.appendChild(s)",
  );
}, 120_000);

test("a facade's own append carries the attributes too", async () => {
  const attrs = await build(ATTRS_SITE, ATTRS_SCRIPTS);
  const html = attrs.get("/") ?? "";

  expect(html).toContain(
    '[["https://example.com/comments.js","data-repo","marker-repo-5b8c/site"]]',
  );
  expect(html).toContain(
    'for(var a=1;a<src.length;a+=2)s.setAttribute(src[a],src[a+1]);s.async=true',
  );
}, 120_000);

test("a declared integrity survives the config loader and reaches the page with its CORS mode", async () => {
  const attrs = await build(ATTRS_SITE, ATTRS_SCRIPTS);
  const html = attrs.get("/") ?? "";

  expect(html).toContain(
    '[["https://example.com/widget@1.2.3.js","integrity","sha384-marker-integrity-3e7a","crossorigin","anonymous"],"analytics",0]',
  );
}, 120_000);

test("a site that declares no integrity carries none of it", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);

  for (const html of loaded.values()) {
    expect(html).not.toContain("integrity");
    expect(html).not.toContain("crossorigin");
  }
}, 120_000);

test("a site that declares no attribute map gets the loader it got before the field existed", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);

  for (const html of loaded.values()) {
    expect(html).toContain(
      'var load=function(u){for(var i=0;i<u.length;i++){var s=document.createElement("script");s.src=u[i];s.async=true;document.head.appendChild(s)}};',
    );
    expect(html).not.toContain("setAttribute");
  }
}, 120_000);

// Computed here, not imported, so the build's spelling is checked against CSP's.
function cspHash(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

function loaderOf(html: string): string {
  const bare = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? "")
    .filter(
      (text) =>
        !text.includes("marker-prepaint-8e40") &&
        !text.includes("marker-snippet-4b1c"),
    );
  expect(bare).toHaveLength(1);
  return bare[0] ?? "";
}

function prePaintOf(html: string): string {
  const found = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? "")
    .filter((text) => text.includes("marker-prepaint-8e40"));
  expect(found).toHaveLength(1);
  return found[0] ?? "";
}

test("every page carrying the script loader records its CSP hash off the emitted document", async () => {
  const loaded = await build(LOADED_SITE, LOADED_SCRIPTS);
  const manifest = manifests.get(LOADED_SITE);

  expect(manifest?.pages.map((page) => page.path).sort()).toEqual([
    "/",
    "/post",
  ]);
  for (const page of manifest?.pages ?? []) {
    const html = loaded.get(page.path) ?? "";
    expect(`${page.path}: ${String(page.inlineScriptHashes)}`).toBe(
      `${page.path}: ${cspHash(prePaintOf(html))},${cspHash(loaderOf(html))}`,
    );
  }
}, 120_000);

test("two pages with different loadouts record different script loader hashes", async () => {
  await build(LOADED_SITE, LOADED_SCRIPTS);
  const rows = new Map(
    manifests.get(LOADED_SITE)?.pages.map((page) => [page.path, page]),
  );
  const home = rows.get("/")?.inlineScriptHashes;
  const post = rows.get("/post")?.inlineScriptHashes;

  expect(home).toHaveLength(2);
  expect(post).toHaveLength(2);
  expect(home?.[0]).toBe(post?.[0]);
  expect(home?.[1]).not.toBe(post?.[1]);
}, 120_000);

test("a page with no script loader records no inline script hashes at all", async () => {
  await build(PLAIN_SITE);
  await build(SILENT_SITE, SILENT_SCRIPTS);
  await build(OFF_SITE, OFF_SCRIPTS);

  for (const root of [PLAIN_SITE, SILENT_SITE, OFF_SITE]) {
    const pages = manifests.get(root)?.pages ?? [];
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(Object.hasOwn(page, "inlineScriptHashes")).toBe(false);
    }
  }
}, 120_000);

async function incrementalBuild(cwd: string): Promise<string> {
  const { runCli } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["build", "--incremental"], {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return out.join("\n");
}

function hashesOf(manifest: Manifest): Record<string, unknown> {
  return Object.fromEntries(
    manifest.pages.map((page) => [page.path, page.inlineScriptHashes]),
  );
}

test("an incremental build records the script loader hashes a full build of the same store records", async () => {
  const root = site(INCREMENTAL_SITE, LOADED_SCRIPTS);
  const dist = join(root, "dist");
  const file = join(dist, "manifest.json");
  const read = (): Manifest => readManifest(readFileSync(file, "utf8"), file);
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
  const full = read();

  rmSync(dist, { recursive: true, force: true });
  cpSync(before, dist, { recursive: true });
  expect(await incrementalBuild(root)).toContain(
    "incremental: 1 of 2 pages rendered, 1 reused, 0 removed",
  );
  const incremental = read();

  expect(Object.keys(hashesOf(full)).sort()).toEqual(["/", "/post"]);
  for (const hashes of Object.values(hashesOf(full))) {
    expect(hashes).toHaveLength(2);
  }
  expect(hashesOf(incremental)).toEqual(hashesOf(full));
}, 360_000);

// A copy at a new path: Node caches a config module by URL.
function copySite(
  from: string,
  to: string,
  edit: (config: string) => string = (config) => config,
): string {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  const config = join(to, "pagedeck.config.ts");
  const text = readFileSync(config, "utf8").replaceAll(from, to);
  writeFileSync(config, edit(text));
  return to;
}

function moveScript(config: string): string {
  expect(config).toContain("https://example.com/experiment.js");
  return config.replace(
    "https://example.com/experiment.js",
    "https://example.com/experiment-v2.js",
  );
}

test("a page an incremental build carries records the hash of the script loader its document holds", async () => {
  const first = site(CARRIED_SITE, LOADED_SCRIPTS);
  await run(first, "sync");
  await run(first, "build");

  const root = copySite(first, EDITED_SITE, moveScript);
  writeFileSync(
    join(root, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 2, data: { title: "home, edited" } })}\n`,
  );
  await run(root, "sync");
  expect(await incrementalBuild(root)).toContain(
    "incremental: 1 of 2 pages rendered, 1 reused, 0 removed",
  );
  const dist = join(root, "dist");
  const file = join(dist, "manifest.json");
  const incremental = readManifest(readFileSync(file, "utf8"), file);
  const post = incremental.pages.find((page) => page.path === "/post");
  const carried = readFileSync(join(dist, post?.html ?? ""), "utf8");

  expect(carried).toContain("https://example.com/experiment.js");
  expect(carried).not.toContain("https://example.com/experiment-v2.js");
  expect(post?.inlineScriptHashes).toEqual([
    cspHash(prePaintOf(carried)),
    cspHash(loaderOf(carried)),
  ]);

  const recomposed = copySite(root, RECOMPOSED_SITE);
  rmSync(join(recomposed, "dist"), { recursive: true, force: true });
  await run(recomposed, "build");
  const fullFile = join(recomposed, "dist", "manifest.json");
  const full = readManifest(readFileSync(fullFile, "utf8"), fullFile);
  const fullPost = full.pages.find((page) => page.path === "/post");
  expect(fullPost?.inlineScriptHashes).toHaveLength(2);
  expect(fullPost?.inlineScriptHashes).not.toEqual(post?.inlineScriptHashes);
}, 360_000);
