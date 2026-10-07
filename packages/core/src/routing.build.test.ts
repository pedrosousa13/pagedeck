import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const root = (name: string): string =>
  join(import.meta.dirname, "..", `.pagedeck-build-test-routing-${name}`);

const MOVED = "/old";
const TARGET = "/pricing";

const NAV = `import { createElement } from "react";
export default function Nav({ title, links }) {
  return createElement(
    "nav",
    null,
    "marker-nav-4f31 " + title,
    links.map((href) => createElement("a", { key: href, href }, href)),
  );
}
`;

function site(
  name: string,
  routing: string,
  links: readonly string[],
  origin?: string,
): string {
  const dir = root(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "components"), { recursive: true });
  writeFileSync(join(dir, "components", "Nav.js"), NAV);

  for (const [path, data] of [
    ["home", { title: "Home", links }],
    ["about", { title: "About", links: ["/"] }],
    ["pricing", { title: "Pricing", links: ["/"] }],
    ["404", { title: "Not found", links: ["/"] }],
  ] as const) {
    const file = join(dir, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
  }

  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",${
      origin === undefined ? "" : `\n    origin: ${JSON.stringify(origin)},`
    }${routing}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: { Nav: "./components/Nav.js" },
    content: (page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      return {
        tree: [
          {
            component: "Nav",
            props: { title: entry.data.title, links: entry.data.links },
          },
        ],
      };
    },
  },
});
`,
  );
  return dir;
}

interface Run {
  code: number;
  err: string;
}

async function pagedeck(cwd: string, verb: string): Promise<Run> {
  try {
    const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: EXIT_CODES.success, err: stderr };
  } catch (thrown) {
    const failure = thrown as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, err: failure.stderr ?? "" };
  }
}

async function build(dir: string): Promise<Run> {
  const synced = await pagedeck(dir, "sync");
  if (synced.code !== EXIT_CODES.success) throw new Error(synced.err);
  return pagedeck(dir, "build");
}

function emitted(dir: string): Manifest {
  const file = join(dir, "dist", MANIFEST_FILE);
  return readManifest(readFileSync(file, "utf8"), file);
}

const REDIRECT_RULE =
  `{ from: ${JSON.stringify(MOVED)}, ` +
  `to: ${JSON.stringify(TARGET)}, status: 301 }`;

const FULL_ROUTING = `
    routing: {
      redirects: [${REDIRECT_RULE}],
      notFound: [{ locale: "en", path: "/404" }],
      headers: [
        { prefix: "/docs/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
      ],
    },`;

const DIRS: string[] = [];
const at = (
  name: string,
  routing: string,
  links: readonly string[],
  origin?: string,
): string => {
  const dir = site(name, routing, links, origin);
  DIRS.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

test("a site declaring redirects, a 404 page and headers has them in its manifest", async () => {
  const dir = at("full", FULL_ROUTING, ["/about"]);

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(emitted(dir).routing).toEqual({
    version: 1,
    site: { trailingSlash: "never" },
    trees: [
      {
        redirects: [
          {
            from: MOVED,
            to: TARGET,
            status: 301,
            source: "config",
            via: [],
          },
        ],
        notFound: "/404",
        headers: [
          {
            prefix: "/docs/",
            set: [{ name: "X-Frame-Options", value: "DENY" }],
          },
        ],
      },
    ],
  });
}, 120_000);

test("a site that declares no routing writes an empty routing document, and the field costs it the manifest bytes, the not-found page's document and its tree-root 404.html, and nothing else", async () => {
  const plain = at("plain", "", ["/about"]);
  const declared = at("declared", FULL_ROUTING, ["/about"]);

  expect((await build(plain)).code).toBe(EXIT_CODES.success);
  expect((await build(declared)).code).toBe(EXIT_CODES.success);

  expect(emitted(plain).routing).toEqual({
    version: 1,
    site: { trailingSlash: "never" },
    trees: [{ redirects: [], headers: [] }],
  });
  expect(diffOutputTrees(join(plain, "dist"), join(declared, "dist"))).toEqual([
    { path: "404.html", difference: "second-only" },
    { path: "404/index.html", difference: "bytes" },
    { path: MANIFEST_FILE, difference: "bytes" },
  ]);
}, 120_000);

test("a page linking a redirected URL warns with the direct target, where the same link without the rule refuses the build", async () => {
  const unrouted = at("unrouted", "", [MOVED]);
  const redirected = at("redirected", FULL_ROUTING, [MOVED]);

  const broken = await build(unrouted);
  expect(broken.code).toBe(EXIT_CODES.configError);
  expect(broken.err).toContain(
    "Site build: 1 reference names nothing this build emitted",
  );

  const result = await build(redirected);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toContain(
    "Site build: 1 reference resolves through a redirect — point it at the target on the line below",
  );
  expect(result.err).toMatch(/^pagedeck: {3}en \/ — "\/old" → "\/pricing"$/m);
  expect(readFileSync(join(redirected, "dist", "index.html"), "utf8")).toContain(
    `href="${MOVED}"`,
  );
}, 180_000);

test("an off-site redirect refuses the build, naming the config field and the end that is wrong", async () => {
  const dir = at(
    "offsite",
    `
    routing: {
      redirects: [
        { from: "/old", to: "https://evil.example/x" },
        { from: "//other.example/a", to: "/about" },
      ],
    },`,
    ["/about"],
  );

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "Routing manifest: 1 redirect target is not a path on this site",
  );
  expect(result.err).toContain(
    "pagedeck:   build.routing.redirects[0] — the target holds a scheme",
  );
  expect(result.err).toContain(
    "Routing manifest: 1 redirect source is not a path on this site",
  );
  expect(result.err).toContain(
    'pagedeck:   build.routing.redirects[1] — the source begins "//", which is a host',
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a shadowed page, a dead target and a contested path are all refused in one build", async () => {
  const dir = at(
    "table",
    `
    routing: {
      redirects: [
        { from: "/about", to: "/pricing" },
        { from: "/gone", to: "/nowhere" },
        { from: "/moved", to: "/about", status: 301 },
        { from: "/moved", to: "/pricing", status: 308 },
      ],
    },`,
    ["/about"],
  );

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "Routing manifest: 1 redirect starts at a path this build serves",
  );
  expect(result.err).toContain(
    'pagedeck:   "/about" in the default tree — build.routing.redirects[0], and the page en /about',
  );
  expect(result.err).toContain(
    "Routing manifest: 1 redirect target is no page of this build",
  );
  expect(result.err).toContain(
    'pagedeck:   build.routing.redirects[1] — "/nowhere" in the default tree',
  );
  expect(result.err).toContain(
    "Routing manifest: 1 path is redirected by more than one rule",
  );
  expect(result.err).toContain(
    'pagedeck:   "/moved" in the default tree — build.routing.redirects[2] (config) to "/about" 301, build.routing.redirects[3] (config) to "/pricing" 308',
  );
}, 120_000);

test("a redirect to the sitemap the build emits is kept in the manifest", async () => {
  const dir = at(
    "file-target",
    `
    sitemap: { pattern: "suffix" },
    routing: {
      redirects: [{ from: "/sitemap-index.xml", to: "/sitemap.xml", status: 301 }],
    },`,
    ["/about"],
    "https://example.com",
  );

  const result = await build(dir);

  expect(result.err).not.toContain("Routing manifest");
  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(join(dir, "dist", "sitemap.xml"))).toBe(true);
  expect(emitted(dir).routing.trees[0]?.redirects).toEqual([
    {
      from: "/sitemap-index.xml",
      to: "/sitemap.xml",
      status: 301,
      source: "config",
      via: [],
      file: true,
    },
  ]);
}, 120_000);

test("a header field named Location refuses the build", async () => {
  const dir = at(
    "location-header",
    `
    routing: {
      headers: [
        { prefix: "/", set: [{ name: "location", value: "https://elsewhere.example/" }] },
      ],
    },`,
    ["/about"],
  );

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    'Routing manifest: 1 header field is named "Location" in some letter case — remove it;',
  );
  expect(result.err).toContain('pagedeck:   build.routing.headers[0].set[0] — "location"');
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a header value no edge target can send refuses the build", async () => {
  const dir = at(
    "unsendable-header-value",
    `
    routing: {
      headers: [
        { prefix: "/", set: [{ name: "Link", value: "</next>; rel=next \\u2192" }] },
      ],
    },`,
    ["/about"],
  );

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "Routing manifest: 1 header value cannot be sent — remove the character;",
  );
  expect(result.err).toContain(
    'pagedeck:   build.routing.headers[0].set[0] — "Link" — the header value holds U+2192',
  );
  expect(existsSync(join(dir, "dist"))).toBe(false);
}, 120_000);

test("a redirect loop refuses the build, naming the hops in order", async () => {
  const dir = at(
    "loop",
    `
    routing: {
      redirects: [
        { from: "/a", to: "/b" },
        { from: "/b", to: "/a" },
      ],
    },`,
    ["/about"],
  );

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("Routing manifest: 1 redirect chain is a loop");
  expect(result.err).toContain('pagedeck:   the default tree — "/a" → "/b" → "/a"');
}, 120_000);

test("a malformed routing config is refused when the config loads, before anything renders", async () => {
  const dir = at(
    "malformed",
    `
    routing: { headers: [{ prefix: "/docs/" }] },`,
    ["/about"],
  );

  const result = await pagedeck(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    '"build.routing" declares 1 rule field this build cannot route with',
  );
  expect(result.err).toContain('pagedeck:   headers[0] — "set" — undefined');
  expect(existsSync(join(dir, "content.db"))).toBe(false);
}, 120_000);

// The arms are authored `c` before `b`, so the order observed is name order.
const ORIGIN = "https://example.test";
const SPLIT = `
    routing: {
      experiments: [
        {
          locale: "en",
          path: "/pricing",
          cookie: "fw_pricing",
          variants: [
            { name: "c", weight: 25 },
            { name: "b", weight: 75 },
          ],
        },
      ],
    },`;

test("a page declaring two variants emits both arms beside the primary, each canonicalizing to the primary", async () => {
  const dir = at("variants", SPLIT, ["/about"], ORIGIN);

  const result = await build(dir);

  expect(result.code).toBe(EXIT_CODES.success);
  const document = (path: string): string =>
    readFileSync(join(dir, "dist", path), "utf8");
  const primary = document("pricing/index.html");
  expect(primary).toContain(`<link rel="canonical" href="${ORIGIN}/pricing">`);
  for (const name of ["b", "c"]) {
    expect(document(`_v/${name}/pricing/index.html`)).toBe(primary);
  }
  expect(existsSync(join(dir, "dist", "_v", "b", "about"))).toBe(false);

  const manifest = emitted(dir);
  expect(
    manifest.pages.find((page) => page.path === "/pricing")?.variants,
  ).toEqual([
    { name: "b", html: "/_v/b/pricing/index.html" },
    { name: "c", html: "/_v/c/pricing/index.html" },
  ]);
  expect(
    manifest.pages.filter((page) => page.variants !== undefined),
  ).toHaveLength(1);
  expect(
    manifest.files.filter((file) => file.path.startsWith("/_v/")),
  ).toHaveLength(2);
}, 180_000);

test("declaring an experiment costs a site two arm documents and the manifest bytes recording them, and nothing else", async () => {
  const plain = at("no-split", "", ["/about"], ORIGIN);
  const split = at("split", SPLIT, ["/about"], ORIGIN);

  expect((await build(plain)).code).toBe(EXIT_CODES.success);
  expect((await build(split)).code).toBe(EXIT_CODES.success);

  expect(diffOutputTrees(join(plain, "dist"), join(split, "dist"))).toEqual([
    { path: "_v/b/pricing/index.html", difference: "second-only" },
    { path: "_v/c/pricing/index.html", difference: "second-only" },
    { path: MANIFEST_FILE, difference: "bytes" },
  ]);
  const document = JSON.stringify(emitted(plain));
  expect(document).not.toContain("variants");
  expect(document).not.toContain("experiments");
}, 240_000);
