import {
  mkdirSync,
  readdirSync,
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

const ROOT = join(SITES, ".pagedeck-domain-spellings-test");

const HOST = "xn--mnchen-3ya.de";

const COMPONENT = `export default function Copy() { return "marker-copy-396"; }\n`;

function site(root: string, declared = "münchen.de"): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  for (const locale of ["de", "de-AT"]) {
    for (const path of ["home", "pricing"]) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: {} })}\n`);
    }
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
    robots: { disallow: ["/admin"] },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        de: { label: "Deutsch", direction: "ltr", domain: ${JSON.stringify(declared)} },
        "de-AT": { label: "Deutsch (AT)", direction: "ltr", domain: "xn--mnchen-3ya.de" },
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
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
  return root;
}

async function exec(
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

async function run(cwd: string, ...argv: string[]): Promise<void> {
  const { code, err } = await exec(cwd, ...argv);
  if (code !== EXIT_CODES.success) throw new Error(err);
}

interface Built {
  readonly dist: string;
  readonly manifest: Manifest;
}

let built: Promise<Built> | undefined;

function build(): Promise<Built> {
  built ??= (async () => {
    const dir = site(ROOT);
    await run(dir, "sync");
    await run(dir, "build");
    const dist = join(dir, "dist");
    const file = join(dist, "manifest.json");
    return { dist, manifest: readManifest(readFileSync(file, "utf8"), file) };
  })();
  return built;
}

const REFUSED = ["..", "%2e%2e", "\u3002\u3002"];

function refusedRoot(index: number): string {
  return join(SITES, `.pagedeck-domain-refused-test-${String(index)}`);
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  REFUSED.forEach((_, index) => {
    rmSync(refusedRoot(index), { recursive: true, force: true });
  });
});

function text(dist: string, path: string): string {
  return readFileSync(join(dist, HOST, path), "utf8");
}

function canonical(html: string): string {
  return /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1] ?? "";
}

function hreflangs(html: string): ReadonlyMap<string, string> {
  const links = html.matchAll(
    /<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g,
  );
  return new Map(
    [...links].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}

function locs(xml: string): readonly string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(
    (match) => match[1] ?? "",
  );
}

test("two spellings of one host write one tree directory, named by the normalized host", async () => {
  const { dist, manifest } = await build();

  const directories = readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(directories).toEqual([HOST]);

  expect(
    manifest.pages
      .map((page) => `${page.locale} ${page.domain ?? ""} ${page.html}`)
      .sort(),
  ).toEqual([
    `de ${HOST} //${HOST}/de/index.html`,
    `de ${HOST} //${HOST}/de/pricing/index.html`,
    `de-AT ${HOST} //${HOST}/de-AT/index.html`,
    `de-AT ${HOST} //${HOST}/de-AT/pricing/index.html`,
  ]);
  expect(text(dist, "de/pricing/index.html")).toContain("marker-copy-396");
  expect(text(dist, "de-AT/pricing/index.html")).toContain("marker-copy-396");

  expect(new Set(manifest.files.map((file) => file.domain))).toEqual(
    new Set([HOST]),
  );
  expect(
    manifest.files.filter((file) => file.path === "/robots.txt"),
  ).toHaveLength(1);
  expect(
    manifest.files.filter((file) => file.path === "/sitemap.xml"),
  ).toHaveLength(1);
}, 120_000);

test("each locale's canonical and hreflang use the domain as that locale declared it", async () => {
  const { dist } = await build();

  const de = text(dist, "de/pricing/index.html");
  const at = text(dist, "de-AT/pricing/index.html");

  expect(canonical(de)).toBe("https://münchen.de/de/pricing");
  expect(canonical(at)).toBe("https://xn--mnchen-3ya.de/de-AT/pricing");
  const expected = new Map([
    ["de", "https://münchen.de/de/pricing"],
    ["de-AT", "https://xn--mnchen-3ya.de/de-AT/pricing"],
  ]);
  expect(hreflangs(de)).toEqual(expected);
  expect(hreflangs(at)).toEqual(expected);
}, 120_000);

test("each locale's sitemap <loc> uses the domain as that locale declared it", async () => {
  const { dist } = await build();

  expect(locs(text(dist, "sitemap-de.xml"))).toEqual([
    "https://münchen.de/de",
    "https://münchen.de/de/pricing",
  ]);
  expect(locs(text(dist, "sitemap-de-AT.xml"))).toEqual([
    "https://xn--mnchen-3ya.de/de-AT",
    "https://xn--mnchen-3ya.de/de-AT/pricing",
  ]);
  expect(locs(text(dist, "sitemap.xml"))).toEqual([
    "https://münchen.de/sitemap-de.xml",
    "https://xn--mnchen-3ya.de/sitemap-de-AT.xml",
  ]);
}, 120_000);

test.each(REFUSED.map((domain, index) => [domain, index] as const))(
  "a domain %j that resolves to the parent of outDir is refused at config load, before anything is written",
  async (domain, index) => {
    const dir = site(refusedRoot(index), domain);
    const before = readdirSync(dir, { recursive: true }).sort();

    const synced = await exec(dir, "sync");
    const built = await exec(dir, "build");

    expect(synced.code).toBe(EXIT_CODES.configError);
    expect(built.code).toBe(EXIT_CODES.configError);
    expect(synced.err).toContain(`"de": ${JSON.stringify(domain)} — the domain parses to a tree key that is not a host name`);
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  },
  120_000,
);
