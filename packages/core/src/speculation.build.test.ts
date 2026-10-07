import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { VARIANT_SEGMENT } from "./routing.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const PLAIN_SITE = join(SITES, ".pagedeck-speculation-plain-test");
const RULES_SITE = join(SITES, ".pagedeck-speculation-rules-test");
const TRANSITION_SITE = join(SITES, ".pagedeck-speculation-transition-test");

const EXTERNAL = "https://example.org/elsewhere";

const CONTENT: Record<string, Record<string, unknown>> = {
  "en/nav": { links: ["home", "pricing", "about", "docs"] },
  "en/home": {
    // Cross-tree first: the German page is dropped for its tree, and the cap of 2 then falls
    // on the three left.
    cross: ["de/impressum"],
    links: ["pricing", "about", "docs"],
    external: [EXTERNAL],
  },
  "en/pricing": { links: ["home"] },
  "en/about": { reads: ["docs"] },
  "en/docs": {},
  "de/impressum": {},
};

const COMPONENT = `export default function Copy() { return "marker-copy-42b7"; }\n`;

const SPLIT = `
    routing: {
      experiments: [
        {
          locale: "en",
          path: "/pricing",
          cookie: "fw_pricing",
          variants: [
            { name: "b", weight: 50 },
            { name: "c", weight: 50 },
          ],
        },
      ],
    },`;

// `relatesTo`, `dependsOn` and `sharedDependsOn` all wired: with `relatesTo` alone the
// assertions could not tell which list the join reads.
function site(root: string, declared = ""): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  for (const [id, data] of Object.entries(CONTENT)) {
    const file = join(root, "content", `${id}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
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
    ${SPLIT}
    ${declared}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) =>
            entry.path === "nav"
              ? undefined
              : entry.path === "home"
                ? "/"
                : "/" + entry.path,
          relatesTo: (entry) => [
            ...((entry.data.cross ?? []).map((one) => ({
              collection: "pages",
              locale: one.split("/")[0],
              path: one.split("/")[1],
            }))),
            ...((entry.data.links ?? []).map((path) => ({
              collection: "pages",
              locale: entry.locale,
              path,
            }))),
          ],
          dependsOn: (entry) => [
            ...((entry.data.links ?? []).map((path) => ({
              collection: "pages",
              locale: entry.locale,
              path,
            }))),
            ...((entry.data.reads ?? []).map((path) => ({
              collection: "pages",
              locale: entry.locale,
              path,
            }))),
          ],
          sharedDependsOn: () => [
            { collection: "pages", locale: "en", path: "nav" },
          ],
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

interface Built {
  readonly dist: string;
  readonly manifest: Manifest;
  readonly documents: ReadonlyMap<string, string>;
}

const built = new Map<string, Promise<Built>>();

function build(root: string, declared = ""): Promise<Built> {
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
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return {
    dist,
    manifest,
    documents: new Map(
      manifest.pages.map((page) => [
        `${page.locale} ${page.path}`,
        readFileSync(join(dist, treeRelative(page.html)), "utf8"),
      ]),
    ),
  };
}

function treeRelative(key: string): string {
  return key.startsWith("//") ? key.slice(2) : key.slice(1);
}

function rulesOf(html: string): unknown {
  const found = /<script type="speculationrules">([\s\S]*?)<\/script>/.exec(
    html,
  );
  return found === null ? undefined : JSON.parse(found[1] ?? "");
}

function scriptTags(html: string): readonly string[] {
  return [...html.matchAll(/<script\b([^>]*)>/g)].map((one) =>
    (one[1] ?? "").trim(),
  );
}

const RULES = `speculation: { action: "prefetch", max: 2 },`;
const TRANSITIONS = `viewTransitions: true,`;

afterAll(() => {
  for (const root of [PLAIN_SITE, RULES_SITE, TRANSITION_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site that declares neither field writes neither block", async () => {
  const plain = await build(PLAIN_SITE);

  expect(plain.documents.size).toBe(5);
  for (const html of plain.documents.values()) {
    expect(html).not.toContain("speculationrules");
    expect(html).not.toContain("@view-transition");
  }
}, 120_000);

test("a page's rules are the pages its declared relations resolve to, capped", async () => {
  const rules = await build(RULES_SITE, RULES);

  expect(rulesOf(rules.documents.get("en /") ?? "")).toEqual({
    prefetch: [{ source: "list", urls: ["/pricing", "/about"] }],
  });
  expect(rulesOf(rules.documents.get("en /pricing") ?? "")).toEqual({
    prefetch: [{ source: "list", urls: ["/"] }],
  });
}, 120_000);

test("a page's dependencies are not its targets, however well they would join", async () => {
  const rules = await build(RULES_SITE, RULES);

  expect(
    rules.manifest.pages.map((one) => `${one.locale} ${one.path}`),
  ).not.toContain("en /nav");
  expect(rulesOf(rules.documents.get("en /about") ?? "")).toBeUndefined();
  expect(rulesOf(rules.documents.get("en /docs") ?? "")).toBeUndefined();

  const about = rules.manifest.pages.find(
    (one) => one.locale === "en" && one.path === "/about",
  );
  expect(about?.dependencies).toContainEqual({
    collection: "pages",
    locale: "en",
    path: "docs",
  });
  expect(about?.dependencies).toContainEqual({
    collection: "pages",
    locale: "en",
    path: "nav",
  });
  expect(
    rules.manifest.pages.map((one) => `${one.locale} ${one.path}`),
  ).toContain("en /docs");
}, 120_000);

test("no experiment arm and no external URL is in any rules document", async () => {
  const rules = await build(RULES_SITE, RULES);
  const row = rules.manifest.pages.find(
    (one) => one.locale === "en" && one.path === "/pricing",
  );
  expect(row?.variants?.map((one) => one.name)).toEqual(["b", "c"]);

  let checked = 0;
  for (const html of rules.documents.values()) {
    const text = JSON.stringify(rulesOf(html) ?? null);
    expect(text).not.toContain(VARIANT_SEGMENT);
    expect(text).not.toContain(EXTERNAL);
    expect(text).not.toContain("example.org");
    checked += 1;
  }
  expect(checked).toBe(5);
}, 120_000);

test("the view-transition rule is on every page, including one linking no sheet", async () => {
  const transitions = await build(TRANSITION_SITE, TRANSITIONS);

  expect(transitions.documents.size).toBe(5);
  for (const html of transitions.documents.values()) {
    expect(html).toContain(
      "<style>@view-transition { navigation: auto; }</style>",
    );
    expect(html).not.toContain('<link rel="stylesheet"');
  }
}, 120_000);

test("neither feature adds a byte of JavaScript", async () => {
  const plain = await build(PLAIN_SITE);
  const rules = await build(RULES_SITE, RULES);
  const transitions = await build(TRANSITION_SITE, TRANSITIONS);

  for (const other of [rules, transitions]) {
    expect(
      diffOutputTrees(plain.dist, other.dist)
        .map((one) => one.path)
        .filter((path) => path.includes("assets/")),
    ).toEqual([]);
    expect(other.manifest.pages.map((one) => one.entryChunk)).toEqual(
      plain.manifest.pages.map((one) => one.entryChunk),
    );
  }

  const html = rules.documents.get("en /") ?? "";
  expect(scriptTags(html)).toEqual(['type="speculationrules"']);
  expect(scriptTags(transitions.documents.get("en /") ?? "")).toEqual([]);
}, 120_000);

test("a declared field moves the documents it is about and nothing else", async () => {
  const plain = await build(PLAIN_SITE);
  const rules = await build(RULES_SITE, RULES);
  const transitions = await build(TRANSITION_SITE, TRANSITIONS);

  expect(
    diffOutputTrees(plain.dist, rules.dist).map((one) => one.path),
  ).toEqual([
    "_v/b/pricing/index.html",
    "_v/c/pricing/index.html",
    "index.html",
    "manifest.json",
    "pricing/index.html",
  ]);
  expect(
    diffOutputTrees(plain.dist, transitions.dist).map((one) => one.path),
  ).toEqual([
    "_v/b/pricing/index.html",
    "_v/c/pricing/index.html",
    "about/index.html",
    "docs/index.html",
    "example.de/impressum/index.html",
    "index.html",
    "manifest.json",
    "pricing/index.html",
  ]);
}, 120_000);
