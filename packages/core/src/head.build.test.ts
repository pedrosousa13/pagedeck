import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const INJECTION = "</script><script>alert(1)</script>";

const COMPONENTS: Record<string, string> = {
  // `Hero` imports a stylesheet so the head has a `<link>` to order the metadata
  // against.
  "Hero.js": `import "./Hero.css";\nexport default function Hero() { return "marker-hero-3e91"; }\n`,
  "Hero.css": `.fw-hero { color: rgb(31, 32, 33); }\n`,
  "Copy.js": `export default function Copy() { return "marker-copy-6a04"; }\n`,
};

const PLAIN_SITE = join(SITES, ".pagedeck-head-plain-test");
const SILENT_SITE = join(SITES, ".pagedeck-head-silent-test");
const HEAD_SITE = join(SITES, ".pagedeck-head-declared-test");

function site(root: string, build = ""): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, title] of [
    ["home", "Home"],
    ["post", INJECTION],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
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
    byTemplate: { landing: usage("Hero"), article: usage("Copy") },
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
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: (page) => ({
      tree: page.path === "/" ? [{ component: "Hero" }] : [{ component: "Copy" }],
    }),
  },
});
`,
  );
  return root;
}

const SILENT_HEAD = `head: (page) => (page.path === "/" ? undefined : {}),`;

const DECLARED_HEAD = `head: (page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      const title = entry.data.title;
      const author = { "@type": "Person", name: "A Writer" };
      return {
        title,
        description: "about " + title,
        image: "https://cdn.example/og.png?w=1200&h=630",
        jsonLd:
          page.template === "article"
            ? [
                { "@context": "https://schema.org", "@type": "Article", headline: title, author },
                {
                  "@context": "https://schema.org",
                  "@type": "BreadcrumbList",
                  itemListElement: [
                    { "@type": "ListItem", position: 1, name: "Home" },
                    { "@type": "ListItem", position: 2, name: title },
                  ],
                },
              ]
            : { "@context": "https://schema.org", "@type": "WebPage", headline: title, author },
      };
    },`;

async function run(cwd: string, ...argv: string[]): Promise<number> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return code;
}

const built = new Map<string, Promise<Map<string, string>>>();

function build(root: string, head = ""): Promise<Map<string, string>> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, head);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  head: string,
): Promise<Map<string, string>> {
  const dir = site(root, head);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return new Map(
    manifest.pages.map((page) => [
      page.path,
      readFileSync(join(dist, page.html), "utf8"),
    ]),
  );
}

afterAll(() => {
  for (const root of [PLAIN_SITE, SILENT_SITE, HEAD_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

const REQUIRED_TERMS: Record<string, readonly string[]> = {
  Article: ["headline", "author"],
  WebPage: ["headline", "author"],
  Person: ["name"],
  BreadcrumbList: ["itemListElement"],
  ListItem: ["position", "name"],
};

const jsonLdValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonLdValue),
    jsonLdNode,
  ]),
);

const jsonLdNode: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .record(z.string(), jsonLdValue)
    .refine(
      (node) =>
        (typeof node["@type"] === "string" && node["@type"].length > 0) ||
        (Object.keys(node).length === 1 && typeof node["@id"] === "string"),
      "a node object carries a non-empty @type, or is a bare @id reference",
    )
    .refine(
      (node) =>
        (REQUIRED_TERMS[String(node["@type"])] ?? []).every(
          (term) => term in node,
        ),
      "a node carries every term its @type promises in REQUIRED_TERMS",
    ),
);

const topLevelNode = jsonLdNode.refine(
  (node) => node["@context"] === "https://schema.org",
  'a top-level node declares "@context": "https://schema.org"',
);
const jsonLdDocument = z.union([
  topLevelNode,
  z.array(topLevelNode).nonempty(),
]);

function nodes(
  document: z.infer<typeof jsonLdDocument>,
): readonly Record<string, unknown>[] {
  return Array.isArray(document) ? document : [document];
}

const LD_OPEN = '<script type="application/ld+json">';

function structuredData(html: string): unknown {
  const open = html.indexOf(LD_OPEN);
  if (open === -1) return undefined;
  const start = open + LD_OPEN.length;
  return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
}

test("a site that declares no head emits the document it always did", async () => {
  const plain = await build(PLAIN_SITE);
  const html = plain.get("/") ?? "";

  expect(html).toContain('<meta charset="utf-8">');
  expect(html).not.toContain("<title");
  expect(html).not.toContain("<meta name=");
  expect(html).not.toContain("<meta property=");
  expect(html).not.toContain("application/ld+json");
}, 120_000);

test("a head callback that returns nothing emits no scaffolding, byte for byte", async () => {
  const plain = await build(PLAIN_SITE);
  const silent = await build(SILENT_SITE, SILENT_HEAD);

  expect([...silent.keys()].sort()).toEqual([...plain.keys()].sort());
  expect(silent.size).toBeGreaterThan(0);
  for (const [path, html] of silent) {
    expect(`${path}: ${html}`).toBe(`${path}: ${plain.get(path) ?? ""}`);
  }
}, 120_000);

test("each page type emits valid JSON-LD, from the template the page carries", async () => {
  const site = await build(HEAD_SITE, DECLARED_HEAD);

  const home = nodes(jsonLdDocument.parse(structuredData(site.get("/") ?? "")));
  expect(home.map((node) => node["@type"])).toEqual(["WebPage"]);
  expect(home[0]?.["headline"]).toBe("Home");
  expect(home[0]?.["author"]).toEqual({ "@type": "Person", name: "A Writer" });

  const post = nodes(
    jsonLdDocument.parse(structuredData(site.get("/post") ?? "")),
  );
  expect(post.map((node) => node["@type"])).toEqual([
    "Article",
    "BreadcrumbList",
  ]);
}, 120_000);

test("the schema rejects the documents this build must never emit", () => {
  const ok = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "A",
    author: { "@type": "Person", name: "W" },
  };
  expect(jsonLdDocument.safeParse(ok).success).toBe(true);

  for (const bad of [
    // No key rather than `headline: undefined`: the value grammar refuses that first.
    {
      "@context": "https://schema.org",
      "@type": "Article",
      author: { "@type": "Person", name: "W" },
    },
    { ...ok, author: { name: "W" } },
    { ...ok, author: { "@type": "Person" } },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", position: 1 }],
    },
    { "@type": "Article", headline: "A", author: { "@type": "Person", name: "W" } },
    { ...ok, "@context": "https://example.com" },
    { "@context": "https://schema.org", headline: "A" },
    {},
    [],
  ]) {
    expect(jsonLdDocument.safeParse(bad).success).toBe(false);
  }
});

test("head fields reach the document escaped, and the injection fixture stays inert", async () => {
  const site = await build(HEAD_SITE, DECLARED_HEAD);
  const html = site.get("/post") ?? "";

  // Counted by the build's open tag, not `<script`: the payload's raw `<script` bytes
  // sit inside the OG attribute values.
  expect([...html.matchAll(/<script type=/g)]).toHaveLength(1);
  expect(html).toContain(LD_OPEN);

  const block = html.slice(
    html.indexOf(LD_OPEN) + LD_OPEN.length,
    html.indexOf("</script>", html.indexOf(LD_OPEN)),
  );
  expect(block).not.toContain("<");

  expect(html).toContain(
    "<title>&lt;/script>&lt;script>alert(1)&lt;/script></title>",
  );
  expect(html).toContain(
    '<meta name="description" content="about </script><script>alert(1)</script>">',
  );
  expect(html).toContain(
    '<meta property="og:image" content="https://cdn.example/og.png?w=1200&amp;h=630">',
  );

  const data = nodes(jsonLdDocument.parse(structuredData(html)));
  expect(data[0]?.["headline"]).toBe(INJECTION);
  expect(html).toContain('"headline":"\\u003c/script>');
}, 120_000);

test("the head's children are written in the documented order", async () => {
  const site = await build(HEAD_SITE, DECLARED_HEAD);
  const html = site.get("/") ?? "";
  const head = /<head>\n([\s\S]*?)\n<\/head>/.exec(html)?.[1] ?? "";

  expect(head.split("\n").map(label)).toEqual([
    'meta charset="utf-8"',
    "title",
    'meta name="description"',
    'meta property="og:title"',
    'meta property="og:description"',
    'meta property="og:image"',
    'link rel="modulepreload"',
    'link rel="stylesheet"',
    'script type="application/ld+json"',
  ]);
}, 120_000);

function label(line: string): string {
  const [, tag = "", attribute] = /^<([\w-]+)(?:\s+([\w-]+="[^"]*"))?/.exec(line) ?? [];
  return attribute === undefined ? tag : `${tag} ${attribute}`;
}
