import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const ROOT = join(SITES, ".pagedeck-modulepreload-test");
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Eager.js": `export default function Eager() { return "marker-eager-4b1e"; }\n`,
  "Seen.js": `export default function Seen() { return "marker-seen-7c20"; }\n`,
  "Later.js": `export default function Later() { return "marker-later-93d5"; }\n`,
  "Copy.js": `export default function Copy() { return "marker-copy-0a6f"; }\n`,
};

const CONFIG = `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { SECURITY_HEADERS } from ${JSON.stringify(join(CORE, "routing.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(ROOT, "content"))}),
  schema: false,
};

const TREES = {
  "/": [{ component: "Eager" }, { component: "Seen" }],
  "/later": [{ component: "Later" }],
  "/about": [{ component: "Copy" }],
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
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
      Eager: { path: "./components/Eager.js", hydrate: "load" },
      Seen: { path: "./components/Seen.js", hydrate: "visible" },
      Later: { path: "./components/Later.js", hydrate: "idle" },
      Copy: "./components/Copy.js",
    },
    // Rolldown ignores a group below \`minSize\`; excluded islands keep their own chunks.
    tierPolicy: { minSize: 0, exclude: ["Eager", "Seen", "Later"] },
    content: (page) => ({ tree: TREES[page.path] }),
  },
});
`;

async function run(...argv: string[]): Promise<number> {
  const { runCli } = await import("./cli.js");
  return runCli(argv, {
    cwd: ROOT,
    env: {},
    out: () => undefined,
    err: () => undefined,
  });
}

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(ROOT, "components", file), source);
  }
  for (const [path, title] of [
    ["home", "Home"],
    ["later", "Later"],
    ["about", "About"],
  ]) {
    const file = join(ROOT, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }
  writeFileSync(join(ROOT, "pagedeck.config.ts"), CONFIG);
  expect(await run("sync")).toBe(EXIT_CODES.success);
  expect(await run("build")).toBe(EXIT_CODES.success);
}, 120_000);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function documentAt(path: string): string {
  return readFileSync(join(ROOT, "dist", path, "index.html"), "utf8");
}

function chunk(path: string): string {
  return readFileSync(join(ROOT, "dist", path), "utf8");
}

const STATIC_IMPORT = /(?:^|[;\n}])\s*import\s*(?:[\w$*{},\s]+?from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function resolve(from: string, specifier: string): string {
  return new URL(specifier, `https://site.test${from}`).pathname;
}

function staticClosure(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    for (const [, specifier] of chunk(path).matchAll(STATIC_IMPORT)) {
      const next = resolve(path, specifier as string);
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}

function dynamicImports(paths: readonly string[]): string[] {
  return paths.flatMap((path) =>
    [...chunk(path).matchAll(DYNAMIC_IMPORT)].map(([, specifier]) =>
      resolve(path, specifier as string),
    ),
  );
}

function head(document: string): string {
  return document.slice(document.indexOf("<head>"), document.indexOf("</head>"));
}

function preloads(document: string): string[] {
  return [
    ...head(document).matchAll(/<link rel="modulepreload" href="([^"]+)">/g),
  ].map(([, href]) => href as string);
}

function entryOf(document: string): string {
  const src = /<script type="module" src="([^"]+)"><\/script>/.exec(document)?.[1];
  expect(src).toBeDefined();
  return src as string;
}

test("a page with a load island preloads each chunk its entry imports statically, in a fixed order", () => {
  const home = documentAt("");
  const entry = entryOf(home);
  const closure = staticClosure(entry);
  expect(closure.some((path) => path.includes("/fw-core-"))).toBe(true);

  expect(preloads(home)).toEqual(closure);
  expect(occurrences(home, 'rel="modulepreload"')).toBe(closure.length);
});

test("a chunk reached only through a dynamic import is not preloaded", () => {
  const home = documentAt("");
  const entry = entryOf(home);
  const lazy = dynamicImports([entry, ...staticClosure(entry)]).filter(
    (path) => !staticClosure(entry).includes(path),
  );
  expect(lazy.some((path) => path.includes("/Seen-"))).toBe(true);

  for (const path of lazy) expect(preloads(home)).not.toContain(path);
});

test("a page whose islands all wait for a trigger does not preload the runtime it imports lazily", () => {
  const later = documentAt("later");
  const entry = entryOf(later);
  const closure = staticClosure(entry);
  expect(closure.some((path) => path.includes("/fw-startup-"))).toBe(true);

  expect(preloads(later)).toEqual(closure);
  expect(preloads(later).some((path) => path.includes("/fw-core-"))).toBe(false);
  expect(preloads(later).some((path) => path.includes("/Later-"))).toBe(false);
});

test("a page with no entry script carries no modulepreload link", () => {
  const about = documentAt("about");
  expect(about).not.toContain('type="module"');
  expect(about).not.toContain("modulepreload");
});

function occurrences(document: string, needle: string): number {
  return document.split(needle).length - 1;
}
