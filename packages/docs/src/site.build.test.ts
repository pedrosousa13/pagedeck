import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  DIAGNOSTIC_MARKER,
  readManifest,
  RETENTION_DIR,
  SECURITY_HEADERS,
} from "@pagedeck/core";
import type { Manifest, ManifestPage } from "@pagedeck/core";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { netlify } from "@pagedeck/adapter-netlify";
import { nginx } from "@pagedeck/adapter-nginx";
import { interpretCloudflarePages } from "../../adapter-cloudflare-pages/src/interpret.test-support.js";
import { interpretCloudFront } from "../../adapter-cloudfront/src/interpret.test-support.js";
import { interpretNetlify } from "../../adapter-netlify/src/interpret.test-support.js";
import { interpretNginx } from "../../adapter-nginx/src/interpret.test-support.js";
import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import { createSearchClient } from "@pagedeck/search/query";
import { colourFaults, contrastRatio, pairFaults, readThemes } from "@pagedeck/brand";
import { codeColours } from "./code-colours.test-support.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";

const ADAPTERS = { "cloudfront-function": cloudfront(), netlify: netlify(), nginx: nginx() };

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..");
const OUT = join(SITE, "site");
const STORE = join(SITE, "content.db");
const RETAINED = join(SITE, RETENTION_DIR);

const ROOTS = [join(SITE, "content"), join(SITE, "..", "..", "docs")];

// Written here, not read from `REPOSITORY_DOCS`: a test reading the list it
// checks would pass on any list.
const PUBLISHED = ["adr", "deploy-recipe.md", "error-messages.md"];

const EXCLUDED_ROUTE =
  /^\/(?:agents|specs|research)(?:\/|$)|^\/dogfood-|^\/scaling-verification$|^\/success-criteria$/;

const SEARCH = "/search/";

// The site's default policy, trailing-slashed, so a route built from a file
// path matches what the build actually emits.
function addressed(route: string): string {
  return route === "/" ? route : `${route}/`;
}

const LOCALE = "en";

function contentPages(): ManifestPage[] {
  return manifest.pages.filter((row) => row.path !== SEARCH);
}

const BIN = join(SITE, "..", "core", "dist", "bin.js");

// Only marked lines are faults, and a verb that loads other tools must pass one
// of their lines through, so silencing them fails too (#184).
async function run(
  verb: string,
  loadsOtherTools: boolean,
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  const lines = stderr.split("\n");
  expect(
    lines.filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `)),
  ).toEqual([]);
  if (!loadsOtherTools) return stdout;
  // The bare marker, wider than the filter above: a line naming
  // `pagedeck:compile-islands` is not evidence that another tool's output survived.
  const passedThrough = lines.filter(
    (line) => line.trim() !== "" && !line.startsWith(DIAGNOSTIC_MARKER),
  );
  expect(passedThrough.length).toBeGreaterThan(0);
  return stdout;
}

function documentPaths(root: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      paths.push(...documentPaths(join(root, dirent.name), `${prefix}${dirent.name}/`));
      continue;
    }
    if (!dirent.name.endsWith(".md")) continue;
    paths.push(`${prefix}${dirent.name.slice(0, -".md".length)}`);
  }
  return paths;
}

function assetUrls(html: string): string[] {
  return [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g),
    ...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g),
  ].map((match) => deployKey(match[1] as string));
}

function deployKey(url: string): string {
  return url.startsWith("/") ? url.slice(1) : url;
}

// Drops stylesheets: `build.css` links one on every page, and the checks that
// read this list are about JavaScript.
function nonStyleAssetUrls(html: string): string[] {
  return assetUrls(html).filter((url) => !url.endsWith(".css"));
}

// Escapes twice: once as the sheet writes the selector, then the result for
// `RegExp`, where an unescaped `.` or `[` compiles and silently mis-matches.
function selectorPattern(name: string): string {
  const selector = name.replace(/[^\w-]/g, (char) => `\\${char}`);
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches inside element tags only, so a tag quoted in a fenced block is not
// read as markup. Classes an island writes after hydration go unseen.
function classesOf(html: string): Set<string> {
  const names = new Set<string>();
  for (const [, attribute] of html.matchAll(
    /<[a-zA-Z][^>]*\sclass="([^"]*)"/g,
  )) {
    for (const name of (attribute as string).split(/\s+/)) {
      if (name !== "") names.add(name);
    }
  }
  return names;
}

function linkedCss(html: string): string {
  return assetUrls(html)
    .filter((url) => url.endsWith(".css"))
    .map((url) => readFileSync(join(OUT, url), "utf8"))
    .join("\n");
}

function jsFiles(): string[] {
  return manifest.files
    .filter((file) => file.kind === "js")
    .map((file) => deployKey(file.path));
}

// A substring match over content-hashed names can over-report an edge but never
// miss one, so this is a superset of the real closure.
function jsClosure(from: string): string[] {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = readFileSync(join(OUT, key), "utf8");
    for (const other of jsFiles()) {
      const name = other.slice(other.lastIndexOf("/") + 1);
      if (other !== key && text.includes(name)) queue.push(other);
    }
  }
  return [...seen].sort();
}

function assetFiles(): string[] {
  return manifest.files
    .filter((file) => file.kind === "asset")
    .map((file) => deployKey(file.path));
}

function document(output: string): string {
  return readFileSync(join(OUT, output, "index.html"), "utf8");
}

function page(manifest: Manifest, path: string): ManifestPage {
  const found = manifest.pages.find((row) => row.path === path);
  if (found === undefined) {
    throw new Error(
      `Manifest: records no page ${path} — it holds ${manifest.pages
        .map((row) => row.path)
        .join(", ")}`,
    );
  }
  return found;
}

let manifest: Manifest;

beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(STORE, { force: true });
  rmSync(RETAINED, { recursive: true, force: true });

  await run("sync", false);
  await run("build", true);

  manifest = readManifest(
    readFileSync(join(OUT, "manifest.json"), "utf8"),
    "manifest.json",
  );
}, 120_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(STORE, { force: true });
  rmSync(RETAINED, { recursive: true, force: true });
});

test("every guide and every published repository document becomes a page, and nothing else", () => {
  // A walk, not a list, so a document that stops being published fails here.
  const repository = documentPaths(ROOTS[1] as string).filter((path) =>
    PUBLISHED.some((entry) =>
      entry.endsWith(".md")
        ? `${path}.md` === entry
        : path.startsWith(`${entry}/`),
    ),
  );
  const expected = [
    ...documentPaths(ROOTS[0] as string).map((path) =>
      addressed(path === "index" ? "/" : `/${path}`),
    ),
    ...repository.map((path) => addressed(`/${path}`)),
    SEARCH,
  ].sort();

  expect(manifest.pages.map((row) => row.path).sort()).toEqual(expected);
  expect(expected.length).toBeGreaterThan(10);
  expect(repository.length).toBeGreaterThan(3);
  expect(
    manifest.pages
      .map((row) => row.path)
      .filter((path) => EXCLUDED_ROUTE.test(path)),
  ).toEqual([]);
  expect(page(manifest, "/").output).toBe("/");
  expect(page(manifest, "/error-messages/").output).toBe("/error-messages/");
  expect(manifest.pages.every((row) => row.domain === undefined)).toBe(true);
});

test("every content page is rendered by the one template, from its own entry", () => {
  expect(contentPages().every((row) => row.template === "doc_page")).toBe(true);
  expect(contentPages().every((row) => row.entry !== undefined)).toBe(true);
  expect(
    [...new Set(contentPages().map((row) => row.collection))].sort(),
  ).toEqual(["guides", "repository"]);
  const search = page(manifest, SEARCH);
  expect(search.template).toBeUndefined();
  expect(search.entry).toBeUndefined();
  expect(search.collection).toBeUndefined();
});

test("every content page of the site ships 0 bytes of JavaScript", () => {
  for (const row of contentPages()) {
    const html = document(row.output);
    expect(html).not.toContain("<script");
    expect(nonStyleAssetUrls(html)).toEqual([]);
    expect(row.entryChunk).toBeUndefined();
    expect(row.components).toEqual([]);
  }
  expect(contentPages().length).toBe(manifest.pages.length - 1);
  expect(jsClosure(deployKey(page(manifest, SEARCH).entryChunk as string))).toEqual(
    jsFiles().sort(),
  );
  expect([...new Set(manifest.files.map((file) => file.kind))].sort()).toEqual([
    "asset",
    "css",
    "html",
    "js",
  ]);
});

test("code samples arrive already highlighted, needing no script", () => {
  const html = document("/tutorials/your-first-site");
  expect(html).toMatch(/<span style="color:[^"]+">/);
  // Lowercased on both sides: Lightning CSS lowercases every hex literal it emits,
  // so a migrated colour would not match the markup's casing.
  expect(html).toContain("color:#1F2328");
  expect(linkedCss(html).toLowerCase()).not.toContain("#1f2328");
  expect(html).toContain("defineCollection");
  expect(html).not.toContain("<script");
  expect(document("/reference/cli")).toContain('<pre tabindex="0"><code>');
});

test("the repository's own documents render as the site's content", () => {
  expect(document("/error-messages")).toContain(
    "Error messages are documentation",
  );
  expect(document("/adr/0003-one-canonical-path-spelling")).toContain(
    "A URL has many spellings",
  );
  expect(document("/deploy-recipe")).toContain("the verbs in order");
});

test("every in-page link a document writes resolves to an anchor it holds", () => {
  const dangling: string[] = [];
  let links = 0;
  for (const row of contentPages()) {
    const html = document(row.output);
    const anchors = new Set(
      [...html.matchAll(/ id="([^"]*)"/g)].map((match) => match[1] as string),
    );
    for (const match of html.matchAll(/ href="#([^"]*)"/g)) {
      links += 1;
      const target = match[1] as string;
      if (!anchors.has(target)) dangling.push(`${row.path}#${target}`);
    }
  }
  expect(dangling).toEqual([]);
  expect(links).toBeGreaterThan(200);
});

test("every page carries the whole navigation, grouped into sections", () => {
  const html = document("/error-messages");
  for (const label of [
    "Overview",
    "Tutorials",
    "How-to guides",
    "Reference",
    "Explanation",
  ]) {
    expect(html).toContain(`<h2>${label}</h2>`);
  }
  expect(html).toContain('href="/error-messages/" aria-current="page"');
  expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
});

test("every page declares every document as a dependency it read", () => {
  const documents = contentPages().length;
  for (const row of contentPages()) {
    expect(row.dependencies).toHaveLength(documents);
    expect(row.dependencies[0]?.path).toBe(row.entry?.path);
  }
  expect(page(manifest, SEARCH).dependencies).toHaveLength(documents);
});

test("every file the manifest records is a file on disk", () => {
  const missing = manifest.files.filter(
    (file) => !existsSync(join(OUT, file.domain ?? "", file.path)),
  );
  expect(missing.map((file) => file.path)).toEqual([]);
  expect(manifest.files.length).toBeGreaterThan(0);
});

test("every page carries the title its entry declares", () => {
  expect(document("/error-messages")).toContain("<title>Error messages</title>");
  expect(document("/")).toContain("<title>");

  const untitled = manifest.pages.filter(
    (row) => !/<title>[^<]+<\/title>/.test(document(row.output)),
  );
  expect(untitled.map((row) => row.path)).toEqual([]);
});

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
};

function decodeEntities(value: string, faults: string[], path: string): string {
  return value.replace(
    /&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z][A-Za-z\d]*));/g,
    (reference, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      const decoded = NAMED_ENTITIES[name ?? ""];
      if (decoded !== undefined) return decoded;
      faults.push(`${path}: undecoded reference ${reference}`);
      return reference;
    },
  );
}

test("every page carries one description of its own, 150 characters at most", () => {
  const faults: string[] = [];
  const seen = new Map<string, string>();
  for (const row of manifest.pages) {
    const tags = [
      ...document(row.output).matchAll(
        /<meta name="description" content="([^"]*)">/g,
      ),
    ];
    if (tags.length !== 1) {
      faults.push(`${row.path}: ${String(tags.length)} description tags`);
      continue;
    }
    const description = decodeEntities(tags[0]?.[1] ?? "", faults, row.path);
    if (description.trim() === "") faults.push(`${row.path}: empty`);
    if (description.length > 150) {
      faults.push(`${row.path}: ${String(description.length)} characters`);
    }
    const other = seen.get(description);
    if (other !== undefined) faults.push(`${row.path}: same as ${other}`);
    seen.set(description, row.path);
  }
  expect(faults).toEqual([]);
});

test("/search ships the search island, and it is the only page with an entry chunk", () => {
  const search = page(manifest, SEARCH);
  expect(search.entryChunk).toBeDefined();
  expect(search.components.map((component) => component.name)).toContain(
    "search",
  );

  const html = document(SEARCH);
  expect(html).toContain('data-fw-component="search"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain("Search the documentation");

  expect(
    manifest.pages.filter((row) => row.entryChunk !== undefined).map((row) => row.path),
  ).toEqual([SEARCH]);
  expect(nonStyleAssetUrls(html)).toEqual([
    deployKey(search.entryChunk as string),
  ]);
});

test("the search index is written into the site's output and hashed into the manifest", () => {
  const directory = `search/${LOCALE}`;
  const index = JSON.parse(
    readFileSync(join(OUT, directory, "index.json"), "utf8"),
  ) as { format: number; locale: string; documents: string; shards: readonly { file: string }[] };

  expect(index.format).toBe(1);
  expect(index.locale).toBe(LOCALE);
  expect(index.documents).toBe("documents.json");
  expect(index.shards.length).toBeGreaterThan(0);

  const named = [
    `${directory}/index.json`,
    `${directory}/documents.json`,
    ...index.shards.map((shard) => `${directory}/${shard.file}`),
  ];
  expect(
    assetFiles()
      .filter((path) => !path.startsWith(`${directory}/`))
      .sort(),
  ).toEqual([".assetsignore", "404.html", "_headers", "_redirects", "favicon.ico"]);
  expect(
    assetFiles()
      .filter((path) => path.startsWith(`${directory}/`))
      .sort(),
  ).toEqual([...named].sort());
  for (const path of named) {
    expect(existsSync(join(OUT, path))).toBe(true);
    const file = manifest.files.find((row) => deployKey(row.path) === path);
    expect(file?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(file?.size).toBeGreaterThan(0);
  }

  expect(readdirSync(join(OUT, "search")).sort()).toEqual(
    [LOCALE, "index.html"].sort(),
  );
});

// Quoted, not derived with the index's own tokenizer; "Diátaxis" also exercises
// case folding and code-unit shard ranges.
test("a term from a real document resolves through the emitted shards to that document's route", async () => {
  const client = createSearchClient({
    locale: LOCALE,
    fetch: async (url: string) => {
      const path = join(OUT, deployKey(url));
      return {
        ok: existsSync(path),
        status: existsSync(path) ? 200 : 404,
        json: async () => JSON.parse(readFileSync(path, "utf8")) as unknown,
      };
    },
  });

  const hits = await client.search("Diátaxis");
  expect(hits.map((hit) => hit.path)).toContain(
    "/",
  );
  const hit = hits.find(
    (found) => found.path === "/",
  );
  const titled = /<title>([^<]+)<\/title>/.exec(
    document("/"),
  )?.[1];
  expect(titled).toBeDefined();
  expect(hit?.title).toBe(titled);
  expect(hit?.score).toBeGreaterThan(0);
  expect(hit?.output).toBe(
    page(manifest, "/").output,
  );

  expect(await client.search("zzzznotaword")).toEqual([]);
});

test("no page links a document #576 keeps off the site", () => {
  const links: string[] = [];
  for (const row of manifest.pages) {
    for (const match of document(row.output).matchAll(/ href="([^"#]*)/g)) {
      const href = match[1] as string;
      const relative = /\/(?:agents|specs|research)\/|\/dogfood-/;
      if (EXCLUDED_ROUTE.test(href) || relative.test(href)) {
        links.push(`${row.path} → ${href}`);
      }
    }
  }
  expect(links).toEqual([]);
});

test("the search index holds only published pages, and no term from an excluded document", () => {
  const directory = join(OUT, "search", LOCALE);
  const index = JSON.parse(
    readFileSync(join(directory, "index.json"), "utf8"),
  ) as { shards: readonly { file: string }[] };
  const documents = JSON.parse(
    readFileSync(join(directory, "documents.json"), "utf8"),
  ) as readonly { path: string }[];
  const terms = new Map<string, readonly { d: number }[]>(
    index.shards.flatMap(
      (shard) =>
        JSON.parse(
          readFileSync(join(directory, shard.file), "utf8"),
        ) as [string, { d: number }[]][],
    ),
  );
  const holders = (term: string): string[] =>
    (terms.get(term) ?? []).map(
      (posting) => documents[posting.d]?.path ?? `#${String(posting.d)}`,
    );

  const pages = new Set(manifest.pages.map((row) => row.path));
  expect(documents.filter(({ path }) => !pages.has(path))).toEqual([]);
  expect(
    documents.filter(({ path }) => EXCLUDED_ROUTE.test(path)),
  ).toEqual([]);
  expect(documents.length).toBeGreaterThan(10);

  expect(holders("pedrosousa13")).toEqual([]);
  expect(terms.size).toBeGreaterThan(1000);
});

test("a document's index entry holds no other document's title", () => {
  const directory = join(OUT, "search", LOCALE);
  const index = JSON.parse(
    readFileSync(join(directory, "index.json"), "utf8"),
  ) as { shards: readonly { file: string }[] };
  const documents = JSON.parse(
    readFileSync(join(directory, "documents.json"), "utf8"),
  ) as readonly { path: string; title?: string }[];
  const postings = index.shards
    .flatMap(
      (shard) =>
        JSON.parse(
          readFileSync(join(directory, shard.file), "utf8"),
        ) as [string, { d: number }[]][],
    )
    .find(([term]) => term === "favicon")?.[1];

  const title = documents.find(({ title }) => title === "Favicon");
  expect(title?.path).toBe("/reference/favicon/");
  const source = (path: string): string => {
    const file = path === "/" ? "index" : path.slice(1, -1);
    const found = ROOTS.map((root) => join(root, `${file}.md`)).find(existsSync);
    return found === undefined ? "" : readFileSync(found, "utf8");
  };
  const spelling = documents
    .filter(({ path }) => /favicon/i.test(source(path)))
    .map(({ path }) => path);
  expect(spelling).toContain("/reference/favicon/");
  expect(spelling.length).toBeLessThan(documents.length / 2);

  expect(
    (postings ?? [])
      .map((posting) => documents[posting.d]?.path ?? `#${String(posting.d)}`)
      .sort(),
  ).toEqual(spelling.sort());
});

test('the navigation, the pager, the outline\'s label and the source line carry data-fw-search="ignore", and still render', () => {
  const IGNORE = ' data-fw-search="ignore"';
  const pages = contentPages().map((row) => row.path);
  for (const row of manifest.pages) {
    const html = document(row.output);
    const marked: { open: string; body: string }[] = [];
    const mark = (open: RegExp, tag: string): { open: string; body: string } => {
      const found = open.exec(html)?.[0];
      expect(found, `${row.path}: no ${String(open)}`).toBeDefined();
      const element = { open: found as string, body: elementAt(html, found as string, tag) };
      expect(element.open, row.path).toContain(IGNORE);
      marked.push(element);
      return element;
    };

    const nav = mark(/<nav class="fw-docnav"[^>]*>/, "nav");
    expect(hrefsOf(nav.body).sort(), row.path).toEqual(expect.arrayContaining(pages));

    if (row.path !== SEARCH) {
      const pager = mark(/<nav class="fw-pager"[^>]*>/, "nav");
      expect(hrefsOf(pager.body).length, row.path).toBeGreaterThan(0);
      expect(pager.body, row.path).toMatch(/<span class="fw-pager__title">[^<]+</);
      const source = mark(/<footer class="fw-source"[^>]*>/, "footer");
      expect(source.body, row.path).toContain("Rendered from ");
      if (html.includes('<p class="fw-toc__label"')) {
        const label = mark(/<p class="fw-toc__label"[^>]*>/, "p");
        expect(label.body, row.path).toMatch(/>On this page$/);
      }
    }

    for (const { open } of marked) {
      expect(open, row.path).not.toMatch(/\s(?:hidden|aria-hidden)[\s=>]/);
    }
  }
});

test("a title holding markup reaches the document as text", () => {
  for (const row of manifest.pages) {
    const title = /<title>([^<]*)<\/title>/.exec(document(row.output))?.[1];
    expect(title).toBeDefined();
    expect(title).not.toContain("<");
  }
});

const CLASS_FIX =
  "bring the class within an @source of styles/global.css or give it a rule there, or stop writing it in the markup";

// The class must be a whole selector, at both ends: a compound or descendant
// rule applies conditionally. `var(--x, fallback)` needs no definition.
test("every class the emitted documents carry has a rule in the stylesheet they link", () => {
  const linked = new Set<string>();
  for (const row of manifest.pages) {
    const sheets = assetUrls(document(row.output)).filter((url) =>
      url.endsWith(".css"),
    );
    expect(sheets).toHaveLength(1);
    linked.add(sheets[0] as string);
  }
  expect([...linked]).toHaveLength(1);

  const faults: string[] = [];
  let checked = 0;
  for (const row of manifest.pages) {
    const html = document(row.output);
    const css = linkedCss(html);
    for (const name of classesOf(html)) {
      checked += 1;
      const rule = new RegExp(
        `(?<=(?:^|[{},])\\s*)\\.${selectorPattern(name)}(?![\\w-])\\s*(?:,[^{}]*)?\\{([^}]+)\\}`,
      ).exec(css);
      if (rule === null) {
        faults.push(
          `  ${row.path}: ${name} — no rule in the emitted stylesheet — ${CLASS_FIX}`,
        );
        continue;
      }
      const body = rule[1] as string;
      for (const [, variable] of body.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        if (!css.includes(`${variable as string}:`)) {
          faults.push(
            `  ${row.path}: ${name} — {${body}} reaches ${variable as string}, which this sheet never defines — ${CLASS_FIX}`,
          );
        }
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(checked).toBeGreaterThan(500);
});

const LANDING_ORIGIN = "https://pagedeck.example";

const THEMES = readThemes(
  readFileSync(join(SITE, "..", "brand", "brand.css"), "utf8"),
);

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

function landmarks(html: string): { before: string; main: string; after: string } {
  const open = html.indexOf("<main");
  const close = html.indexOf("</main>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return {
    before: html.slice(html.indexOf("<body"), open),
    main: html.slice(open, close),
    after: html.slice(close),
  };
}

function elementAt(html: string, open: string, tag: string): string {
  const start = html.indexOf(open);
  expect(start, `no ${open}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(`</${tag}>`, start));
}

test("every page has the shared header and footer outside <main>, and one viewport declaration", () => {
  for (const row of manifest.pages) {
    const html = document(row.output);
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.split('name="viewport"').length - 1, row.path).toBe(1);
    const { before, after } = landmarks(html);
    expect(before, row.path).toContain('<header class="fw-bar">');
    expect(before, row.path).toContain('class="fw-wordmark"');
    expect(after, row.path).toContain('<footer class="fw-foot">');
    const chrome = hrefsOf(before + after);
    expect(chrome, row.path).toContain("/");
    expect(chrome, row.path).toContain(SEARCH);
    expect(chrome, row.path).toContain(`${LANDING_ORIGIN}/`);
    expect(
      chrome.filter((href) => /^[a-z]+:/i.test(href) && !href.startsWith(`${LANDING_ORIGIN}/`)),
      row.path,
    ).toEqual([]);
  }
});

test("the navigation collapses on a phone without a script: it is a <details> with a summary", () => {
  for (const row of manifest.pages) {
    const nav = elementAt(document(row.output), '<nav class="fw-docnav"', "details");
    expect(nav, row.path).toMatch(/<details class="fw-docnav__toggle"><summary class="fw-docnav__summary">/);
  }
});

test("every document links the pages before and after it in the navigation's reading order", () => {
  let linked = 0;
  for (const row of contentPages()) {
    const html = document(row.output);
    const order = hrefsOf(elementAt(html, '<nav class="fw-docnav"', "nav"));
    const at = order.indexOf(row.path);
    expect(at, row.path).toBeGreaterThan(-1);
    const pager = hrefsOf(elementAt(html, '<nav class="fw-pager"', "nav"));
    const expected = [order[at - 1], order[at + 1]].filter(
      (href): href is string => href !== undefined,
    );
    expect(pager, row.path).toEqual(expected);
    linked += pager.length;
  }
  expect(linked).toBe(2 * contentPages().length - 2);
});

test("every table sits in a container that scrolls sideways, and a keyboard can reach it", () => {
  let tables = 0;
  for (const row of contentPages()) {
    const html = document(row.output);
    const all = html.match(/<table\b/g)?.length ?? 0;
    const wrapped = html.match(/<div class="fw-table" tabindex="0"><table\b/g)?.length ?? 0;
    expect(wrapped, row.path).toBe(all);
    tables += all;
  }
  expect(tables).toBeGreaterThan(10);
});

test("every code block can take focus, so a keyboard can scroll a long line", () => {
  let blocks = 0;
  for (const row of contentPages()) {
    const html = document(row.output);
    const pres = [...html.matchAll(/<pre\b[^>]*>/g)].map((match) => match[0]);
    expect(pres.filter((tag) => !tag.includes('tabindex="0"')), row.path).toEqual([]);
    blocks += pres.length;
  }
  expect(blocks).toBeGreaterThan(50);
});

test("every colour the stylesheet sets is a brand token", () => {
  const { checked, faults } = colourFaults(linkedCss(document("/")));
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(checked).toBeGreaterThan(10);
});

test("every text/background pair a rule sets is AA in both themes", () => {
  const { measured, faults } = pairFaults(linkedCss(document("/")), THEMES);
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(measured.some((selector) => selector.includes("aria-current"))).toBe(true);
  expect(measured.some((selector) => selector.includes("aria-selected"))).toBe(true);
});

test("every highlighted token reads at 4.5:1 on the code block's surface, in both themes", () => {
  const light = THEMES.light.resolved.get("--fw-bg-raised") as string;
  const dark = THEMES.dark.resolved.get("--fw-bg-raised") as string;
  const colours = { light: new Set<string>(), dark: new Set<string>() };
  const unmeasurable: string[] = [];
  for (const row of contentPages()) {
    const found = codeColours(document(row.output));
    for (const colour of found.light) colours.light.add(colour);
    for (const colour of found.dark) colours.dark.add(colour);
    unmeasurable.push(...found.unmeasurable.map((value) => `  ${row.path}: ${value}`));
  }
  expect(unmeasurable.length === 0 ? "" : `\n${[...new Set(unmeasurable)].join("\n")}`).toBe("");
  const faults = [
    ...[...colours.light].map((colour) => [colour, light, "light"] as const),
    ...[...colours.dark].map((colour) => [colour, dark, "dark"] as const),
  ]
    .map(([colour, surface, theme]) => ({ colour, surface, theme, ratio: contrastRatio(colour, surface) }))
    .filter(({ ratio }) => ratio < 4.5)
    .map(({ colour, surface, theme, ratio }) => `  ${theme}: ${colour} on ${surface} is ${ratio.toFixed(2)}:1`);
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(colours.light.size).toBeGreaterThan(4);
  expect(colours.dark.size).toBeGreaterThan(4);
});

test("the site serves the brand's icon at /favicon.ico", () => {
  expect(readFileSync(join(OUT, "favicon.ico"))).toEqual(
    readFileSync(join(SITE, "..", "brand", "favicon.ico")),
  );
});

const SERVED_HEADERS = [
  ...SECURITY_HEADERS,
  { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
];

function edgeText(target: keyof typeof ADAPTERS, path: string): string {
  return (
    ADAPTERS[target].compile(manifest.routing).artifacts.find(
      (artifact) => artifact.path === path,
    )?.contents ?? ""
  );
}

test("the security headers and the policy are in the edge artifacts for every host", () => {
  const netlify = edgeText("netlify", "/_headers");
  const cloudfront = edgeText("cloudfront-function", "routing.response.js");
  const nginx = edgeText("nginx", "routing.conf");
  for (const { name, value } of SERVED_HEADERS) {
    expect(netlify).toContain(`  ${name}: ${value}\n`);
    expect(cloudfront).toContain(`{ name: "${name.toLowerCase()}", value: "${value}" }`);
    expect(nginx).toContain(`add_header "${name}" "${value}" always;`);
  }
});

test("every host sends the whole policy and the three security headers with every page", async () => {
  const compiled = (target: keyof typeof ADAPTERS) => ADAPTERS[target].compile(manifest.routing).artifacts;
  const cloudfront = compiled("cloudfront-function");
  const netlify = compiled("netlify");
  const nginx = compiled("nginx");
  const expected = comparable({ kind: "pass", headers: SERVED_HEADERS });
  for (const page of manifest.pages) {
    const request = { path: page.output, found: true };
    expect(comparable(resolveRequest(manifest.routing, request)), page.path).toEqual(expected);
    expect(comparable(await interpretCloudFront(cloudfront, request)), page.path).toEqual(expected);
    expect(comparable(interpretNetlify(netlify, request)), page.path).toEqual(expected);
    expect(comparable(interpretNginx(nginx, request)), page.path).toEqual(expected);
  }
});

test("every page's inline scripts are in the policy it is served with, and the policy lists no other", () => {
  const carried = new Set<string>();
  for (const page of manifest.pages) {
    const policy = servedPolicy(page);
    expect(policy, page.path).toBeDefined();
    const allowed = scriptSources(policy ?? "");
    for (const hash of page.inlineScriptHashes ?? []) {
      expect(allowed, `${page.path} carries ${hash}`).toContain(hash);
      carried.add(hash);
    }
  }
  const listed = scriptSources(CONTENT_SECURITY_POLICY).filter((source) =>
    source.startsWith("'sha256-"),
  );
  expect(new Set(listed)).toEqual(carried);
});

test("the _headers the build wrote for Workers Static Assets carries every header of the set", () => {
  const written = readFileSync(join(OUT, "_headers"), "utf8");
  expect(written.startsWith("/*\n")).toBe(true);
  for (const { name, value } of SERVED_HEADERS) {
    expect(written).toContain(`  ${name}: ${value}\n`);
  }
});

const HASHED_DIRECTORIES = ["/assets/"];
const IMMUTABLE = { name: "Cache-Control", value: "public, max-age=31536000, immutable" };

test("the _headers the build wrote serves each hashed file immutable with nosniff, and every other file no Cache-Control", () => {
  const written = ["/_headers", "/_redirects"].map((path) => ({
    role: "tree-file" as const,
    path,
    contents: readFileSync(join(OUT, path), "utf8"),
  }));
  const hashed = (path: string) => HASHED_DIRECTORIES.some((prefix) => path.startsWith(prefix));
  for (const prefix of HASHED_DIRECTORIES) {
    expect(manifest.files.some((file) => file.path.startsWith(prefix)), prefix).toBe(true);
  }
  for (const file of manifest.files) {
    if (hashed(file.path)) {
      expect(file.path, "a file under an immutable prefix carries a content hash").toMatch(
        /[.-][A-Za-z0-9_-]{8}\.[a-z0-9]+$/,
      );
    }
    const expected = hashed(file.path) ? [...SECURITY_HEADERS, IMMUTABLE] : SERVED_HEADERS;
    expect(
      comparable(interpretCloudflarePages(written, { path: file.path, found: true })),
      file.path,
    ).toEqual(comparable({ kind: "pass", headers: expected }));
  }
});

test("the .assetsignore keeps the deploy manifest, the deploy directory and the adapter's fallback 404 out of the upload", () => {
  const ignored = readFileSync(join(OUT, ".assetsignore"), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  expect(ignored).toEqual(["/manifest.json", "/.pagedeck", "/404.html"]);
  const declared = manifest.routing.trees.filter((tree) => tree.notFound !== undefined);
  expect(
    declared.map((tree) => tree.notFound),
    "The docs site declares a 404 page, which core writes to /404.html, and public/.assetsignore drops /404.html from the upload — remove that line from public/.assetsignore and set not_found_handling to \"404-page\" in wrangler.jsonc, then keep /manifest.json from answering 200: with /404.html uploaded, its proxy row answers 307 to /404, which serves the page (#6)",
  ).toEqual([]);
  const proxied = readFileSync(join(OUT, "_redirects"), "utf8");
  expect(proxied).toContain("/manifest.json /404.html 200\n");
});

// The Worker's workers.dev address until #54 names the docs domain. Every README
// spells it, and this is what they are checked against.
const DOCS_ORIGIN = "https://pagedeck-docs.pedrodsousa.workers.dev";

const REPOSITORY = join(SITE, "..", "..");

function linkingFiles(): string[] {
  const packages = readdirSync(join(REPOSITORY, "packages"))
    .map((name) => join("packages", name, "README.md"))
    .filter((path) => existsSync(join(REPOSITORY, path)));
  return [
    "README.md",
    ...packages,
    join("packages", "create-pagedeck", "src", "index.ts"),
  ].sort();
}

const DOCS_LINK = new RegExp(
  `${DOCS_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^)\\s"#]*)(?:#([^)\\s"]*))?`,
  "g",
);

test("every docs link a README writes names a page this build emits, and a heading on it", () => {
  const routes = new Set(manifest.pages.map((row) => row.path));
  const dangling: string[] = [];
  let links = 0;
  for (const file of linkingFiles()) {
    const text = readFileSync(join(REPOSITORY, file), "utf8");
    for (const [href, route, fragment] of text.matchAll(DOCS_LINK)) {
      links += 1;
      if (!routes.has(route as string)) {
        dangling.push(`${file}: ${href} — no page at ${route as string}; link the page's route with its trailing slash`);
        continue;
      }
      if (fragment !== undefined && !document(route as string).includes(` id="${fragment}"`)) {
        dangling.push(`${file}: ${href} — ${route as string} has no heading #${fragment}; link a heading id the page has, or drop the fragment`);
      }
    }
  }
  expect(dangling).toEqual([]);
  expect(links).toBeGreaterThan(20);
});

test("no README links the docs at an origin other than DOCS_ORIGIN", () => {
  const strayLinks = linkingFiles().flatMap((file) =>
    [...readFileSync(join(REPOSITORY, file), "utf8").matchAll(/(https?:\/\/[\w.-]+)[^\s)"'`<>]*/g)]
      .filter(([, origin]) => origin !== DOCS_ORIGIN && /\.workers\.dev$|pagedeck-docs/.test(origin as string))
      .map(([href]) => `${file}: ${href}`),
  );
  expect(strayLinks, `link the page at ${DOCS_ORIGIN}/<route>/ instead (#6)`).toEqual([]);
});

test("no README links the docs' markdown in the repository instead of the deployed site", () => {
  const repositoryLinks = linkingFiles().flatMap((file) =>
    [
      ...readFileSync(join(REPOSITORY, file), "utf8").matchAll(
        /(?:\]\(|")([^)"\s]*packages\/docs\/content[^)"\s]*)/g,
      ),
    ].map((match) => `${file}: ${match[1] as string}`),
  );
  expect(
    repositoryLinks,
    `link the page at ${DOCS_ORIGIN}/<route>/ instead (#6)`,
  ).toEqual([]);
});

function servedPolicy(page: ManifestPage): string | undefined {
  const served = resolveRequest(manifest.routing, { path: page.output, found: true });
  return served.kind === "pass"
    ? served.headers.find((header) => header.name.toLowerCase() === "content-security-policy")
        ?.value
    : undefined;
}

function scriptSources(policy: string): readonly string[] {
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name === "script-src") return sources;
  }
  return [];
}
