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

const roots: string[] = [];

const MODULES: Record<string, string> = {
  "Header.js": `import { createElement } from "react";
export default function Header() {
  return createElement("header", { className: "chrome-header-5e1a" }, "marker-header-5e1a");
}
`,
  "Nav.js": `import { createElement } from "react";
const LINKS = [["/", "Home"], ["/about", "About"]];
export default function Nav({ current }) {
  return createElement(
    "nav",
    { "aria-label": "Site" },
    ...LINKS.map(([href, label]) =>
      createElement(
        "a",
        { key: href, href, "aria-current": href === current ? "page" : undefined },
        label,
      ),
    ),
  );
}
`,
  "Toggle.js": `"use client";
import { createElement } from "react";
export default function Toggle() {
  return createElement("button", { className: "chrome-toggle-3b7c" }, "marker-toggle-3b7c");
}
`,
  "Footer.js": `import { createElement } from "react";
export default function Footer() {
  return createElement("footer", null, "marker-footer-6d02");
}
`,
  "Badge.js": `import { createElement } from "react";
export default function Badge({ tone }) {
  return createElement("span", { className: "badge-" + tone }, "marker-badge-1c88");
}
`,
  "Body.js": `import { createElement } from "react";
export default function Body({ title }) {
  return createElement("article", null, "marker-body-9a14 " + title);
}
`,
  "Mount.js": `import { createElement } from "react";
export default function Mount() {
  return createElement("div", { id: "comments" }, "marker-mount-7b3e");
}
`,
  "Thrower.js": `export default function Thrower() {
  throw new Error("thrower-8e21");
}
`,
  "Element.js": `import { createElement } from "react";
export default function Element({ as }) {
  return createElement(as, null, "marker-element-2c47");
}
`,
};

const CHROME = `(page) => ({
      before: [
        { component: "Header" },
        { component: "Nav", props: { current: page.path } },
        { component: "Toggle" },
      ],
      after: [{ component: "Footer" }],
    })`;

// A directory per call: Node caches a config module by URL, so a second site at one
// path would be built from the first one's config.
function site(name: string, chrome: string, extra = ""): string {
  const root = join(SITES, `.pagedeck-chrome-${name}-test`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(MODULES)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, data] of [
    ["home", { title: "Home", tone: "calm" }],
    ["about", { title: "About", tone: "calm" }],
  ] as const) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
  }

  const names = Object.keys(MODULES).map((file) => file.replace(/\.js$/, ""));
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
${names.map((name) => `      ${name}: "./components/${name}.js",`).join("\n")}
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: (page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      return { tree: [{ component: "Body", props: { title: entry.data.title } }] };
    },
    ${chrome === "" ? "" : `chrome: ${chrome},`}
    ${extra}
  },
});
`,
  );
  return root;
}

interface Run {
  code: number;
  err: string;
}

async function run(cwd: string, ...argv: string[]): Promise<Run> {
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

async function ok(cwd: string, ...argv: string[]): Promise<Run> {
  const result = await run(cwd, ...argv);
  if (result.code !== EXIT_CODES.success) throw new Error(result.err);
  return result;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Built {
  dist: string;
  manifest: Manifest;
  documents: Map<string, string>;
}

async function build(root: string): Promise<Built> {
  for (const verb of ["sync", "build"]) await ok(root, verb);
  const dist = join(root, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const documents = new Map(
    manifest.pages.map((page) => [
      page.path,
      readFileSync(join(dist, page.html), "utf8"),
    ]),
  );
  return { dist, manifest, documents };
}

let framed: Promise<Built> | undefined;
function framedSite(): Promise<Built> {
  framed ??= build(site("framed", CHROME));
  return framed;
}

test("the body holds the chrome before, then <main> with the page tree alone, then the chrome after", async () => {
  const { documents } = await framedSite();
  const html = documents.get("/about") as string;
  const body = html.slice(html.indexOf("<body>"));

  expect(body).toContain(
    "\n<main>\n<article>marker-body-9a14 About</article>\n</main>\n",
  );

  const order = [
    "<body>\n<header",
    "<nav",
    'data-fw-component="Toggle"',
    "<main>",
    "marker-body-9a14",
    "</main>",
    "<footer>",
    '<script type="module"',
  ].map((needle) => body.indexOf(needle));
  expect(order).not.toContain(-1);
  expect(order).toEqual([...order].sort((a, b) => a - b));
}, 120_000);

test("a nav in the chrome marks the page it is rendered for", async () => {
  const { documents } = await framedSite();

  expect(documents.get("/about")).toContain(
    '<a href="/">Home</a><a href="/about" aria-current="page">About</a>',
  );
  expect(documents.get("/")).toContain(
    '<a href="/" aria-current="page">Home</a><a href="/about">About</a>',
  );
}, 120_000);

test("an island in the chrome joins the page's entry, and the chrome's classes are the page's", async () => {
  const { dist, manifest, documents } = await framedSite();

  for (const page of manifest.pages) {
    expect(page.components.map((one) => one.name)).toEqual(["Toggle"]);
    const html = documents.get(page.path) as string;
    const src = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    expect(readFileSync(join(dist, src as string), "utf8")).toContain("Toggle");
  }

  expect(manifest.classes).toContain("chrome-header-5e1a");
  expect(manifest.classes).toContain("chrome-toggle-3b7c");
}, 120_000);

test("a class new to the chrome of a re-rendered page is drift", async () => {
  const root = site(
    "drift",
    `(page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      return { before: [{ component: "Badge", props: { tone: entry.data.tone } }] };
    }`,
  );
  const { manifest } = await build(root);
  expect(manifest.classes).toContain("badge-calm");

  writeFileSync(
    join(root, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "About", tone: "rogue" } })}\n`,
  );
  await ok(root, "sync");
  const { err } = await ok(root, "build", "--incremental");

  expect(err).toContain(
    "Class drift: 1 re-rendered page uses classes the last full build's class manifest does not hold",
  );
  expect(err).toContain('"badge-rogue"');
}, 240_000);

test("a chrome rendering <main> fails the build, naming the page and the chrome", async () => {
  const root = site(
    "refused",
    `() => ({ after: [{ component: "Element", props: { as: "main" } }] })`,
  );
  await ok(root, "sync");
  const { code, err } = await run(root, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    'Entry /en/: build.chrome rendered a <main> landmark — the build writes the one <main> around the page tree and places the chrome before and after it, so a landmark in the chrome is a second one and is not taken in place of the build\'s; render <header>, <nav>, <footer> or a <div> in the chrome instead (CONTEXT.md, "The <main> landmark is the framework\'s, written once per document")',
  );
}, 120_000);

test("a chrome that returns no regions writes the documents a site without chrome writes", async () => {
  const plain = await build(site("plain", ""));
  const empty = await build(site("empty", "() => ({})"));

  expect(plain.documents.size).toBe(2);
  expect(empty.documents).toEqual(plain.documents);
  expect(plain.documents.get("/")).toContain(
    "<body>\n<main>\n<article>marker-body-9a14 Home</article>\n</main>\n</body>",
  );
}, 240_000);

test("a facade mount point the chrome renders is refused with the chrome as the reason", async () => {
  const root = site(
    "mount",
    `() => ({ after: [{ component: "Mount" }] })`,
    `scripts: defineScripts({
      scripts: [
        { name: "comments", src: "https://example.com/comments.js", strategy: "facade", facade: { html: "<button>marker-comments-4d81</button>", mount: "comments" } },
      ],
    }),`,
  );
  await ok(root, "sync");
  const { code, err } = await run(root, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    'Entry /en/: 1 facade declares a mount point only build.chrome renders — a facade\'s placeholder goes inside the <main> landmark with the page\'s content, and the chrome is outside it; move the element carrying the id into the page tree:\n  "comments" — id="comments" is on an element build.chrome renders',
  );
  expect(err).not.toContain("no element on this page carries");
}, 120_000);

test("a chrome component that throws is reported as the chrome's", async () => {
  const root = site("thrower", `() => ({ before: [{ component: "Thrower" }] })`);
  await ok(root, "sync");
  const { code, err } = await run(root, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    'Component "Thrower": threw while rendering build.chrome (before <main>) on entry /en/ — fix the component, or the props build.chrome gives it',
  );
}, 120_000);
