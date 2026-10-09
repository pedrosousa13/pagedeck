import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { beaconElement } from "./beacon.js";
import { coreInlineScripts, eagerChunksByPage, stageUntilSettled } from "./build.js";
import type { ClientBuild } from "./client-build.js";
import type { EntryPlan } from "./entries.js";
import type { OutputDifference } from "./determinism.js";
import { diffOutputTrees, outputDifferenceReport } from "./determinism.js";
import { diffManifests } from "./diff.js";
import { ConfigError, EXIT_CODES } from "./exit.js";
import { ABSENT_FAVICON } from "./favicon.test-support.js";
import { MANIFEST_FILE, MANIFEST_VERSION, readManifest } from "./manifest.js";
import { scriptElements } from "./script-elements.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const RELOADABLE_SITES = fileURLToPath(new URL("../", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Hero.js": `export default function Hero({ title }) { return "marker-hero-41bd" + (title ?? ""); }\n`,
  "Copy.js": `export default function Copy({ title }) { return "marker-copy-7c02" + (title ?? ""); }\n`,
};

interface SiteOptions {
  useClient?: boolean;
  useServer?: boolean;
  preinitInEffect?: boolean;
  globalCss?: boolean;
  staticCss?: boolean;
  unregisteredClient?: boolean;
  noIslands?: boolean;
  workerScripts?: boolean;
  noHeaders?: boolean;
  templateMode?: boolean;
  staticCopy?: boolean;
  staticHero?: boolean;
  packageIsland?: boolean;
  danglingSpecifier?: boolean;
  duplicateClientNames?: boolean;
  nestedClient?: boolean;
  nondeterministicCopy?: boolean;
  // Outside `node_modules`: Vitest hands anything under it to Node's module cache,
  // which `vi.resetModules()` cannot reach (#20).
  reloadable?: boolean;
  markets?: "domains" | "sharedDomain";
  unparsable?: "copy" | "both";
  missingImport?: boolean;
  adapter?: "toggle" | "refuse";
}

function adapterFlagPath(root: string): string {
  return join(root, "adapter-flag.json");
}

interface Market {
  code: string;
  domain?: string;
}

function marketsOf(options: SiteOptions): readonly Market[] {
  if (options.markets === "domains") {
    return [
      { code: "en" },
      { code: "de", domain: "de.example.com" },
      { code: "fr", domain: "fr.example.com" },
    ];
  }
  if (options.markets === "sharedDomain") {
    return [
      { code: "en" },
      { code: "de-ch", domain: "example.ch" },
      { code: "fr-ch", domain: "example.ch" },
    ];
  }
  return [{ code: "en" }];
}

// A fresh directory per call: Node caches the config module by URL, so a reused
// path would build the first site's config.
let siteCount = 0;
const written: string[] = [];

function site(options: SiteOptions = {}): string {
  siteCount += 1;
  const ROOT = join(
    options.reloadable === true ? RELOADABLE_SITES : SITES,
    `.pagedeck-build-test-${String(siteCount)}`,
  );

  written.push(ROOT);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    const directive =
      file === "Hero.js"
        ? options.staticHero === true
          ? `"use client";\n`
          : ""
        : file !== "Copy.js"
          ? ""
          : options.useClient === true
            ? `"use client";\n`
            : options.useServer === true
              ? `"use server";\n`
              : "";
    writeFileSync(join(ROOT, "components", file), directive + source);
  }
  if (options.preinitInEffect === true) {
    writeFileSync(
      join(ROOT, "components", "Copy.js"),
      `"use client";
import { useEffect } from "react";
import { preinit } from "react-dom";
export default function Copy({ title }) {
  useEffect(() => { preinit("/late.css", { as: "style" }); }, []);
  return "marker-copy-7c02" + (title ?? "");
}
`,
    );
  }
  if (options.unparsable !== undefined) {
    writeFileSync(
      join(ROOT, "components", "Copy.js"),
      `export default function Copy() { return "marker-copy-7c02";\n`,
    );
    if (options.unparsable === "both") {
      writeFileSync(
        join(ROOT, "components", "Hero.js"),
        `export default function Hero() { return "marker-hero-41bd";\n`,
      );
    }
  }
  if (options.missingImport === true) {
    writeFileSync(
      join(ROOT, "components", "Copy.js"),
      `import "./Nowhere.js";
export default function Copy() { return "marker-copy-7c02"; }
`,
    );
  }
  if (options.nondeterministicCopy === true) {
    writeFileSync(
      join(ROOT, "components", "Copy.js"),
      `const value = "marker-copy-" + Math.random();
export default function Copy() { return value; }
`,
    );
  }
  if (options.nestedClient === true) {
    writeFileSync(
      join(ROOT, "components", "Plain.js"),
      `export default function Plain() { return "marker-plain-5ab3"; }\n`,
    );
    writeFileSync(
      join(ROOT, "components", "Hero.js"),
      `import { createElement } from "react";
import Copy from "./Copy.js";
export default function Hero() {
  return createElement(
    "div",
    null,
    "marker-hero-41bd",
    createElement(Copy, null),
    createElement(Copy, null),
  );
}
`,
    );
    writeFileSync(
      join(ROOT, "components", "Wrap.js"),
      `import { createElement } from "react";
import Copy from "./Copy.js";
import Plain from "./Plain.js";
export default function Wrap() {
  return createElement(
    "div",
    null,
    "marker-wrap-8d1c",
    createElement(Copy, null),
    createElement(Plain, null),
  );
}
`,
    );
  }
  if (options.packageIsland === true) {
    const pkg = join(ROOT, "node_modules", "design-kit");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      `${JSON.stringify({ name: "design-kit", version: "0.0.0", type: "module", main: "./Badge.js" })}\n`,
    );
    writeFileSync(
      join(pkg, "Badge.js"),
      `"use client";\nexport default function Badge() { return "marker-badge-9e55"; }\n`,
    );
  }
  if (options.globalCss === true || options.staticCss === true) {
    writeFileSync(join(ROOT, "global.css"), `.fw-global { color: red; }\n`);
  }
  if (options.staticCss === true) {
    writeFileSync(
      join(ROOT, "components", "Copy.js"),
      `import "../global.css";\n${COMPONENTS["Copy.js"] as string}`,
    );
  }
  if (options.unregisteredClient === true) {
    writeFileSync(
      join(ROOT, "components", "Toggle.js"),
      `"use client";\nexport default function Toggle() { return "marker-toggle-3f6a"; }\n`,
    );
    writeFileSync(
      join(ROOT, "components", "Copy.js"),
      `import Toggle from "./Toggle.js";\nexport default function Copy() { return "marker-copy-7c02" + Toggle(); }\n`,
    );
  }
  const markets = marketsOf(options);
  for (const market of markets) {
    for (const [path, title] of [
      ["home", "Home"],
      ["about", "About"],
    ]) {
      const file = join(ROOT, "content", market.code, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ rev: 1, data: { title: `${title} ${market.code}` } })}\n`,
      );
    }
  }

  const badge = options.packageIsland === true;
  const hero =
    options.danglingSpecifier === true
      ? "./components/Missing.js"
      : "./components/Hero.js";
  const nested = options.nestedClient === true;
  const copyHydrate = options.staticCopy === true ? `, hydrate: "none"` : "";
  const heroHydrate =
    options.staticHero === true || options.noIslands === true
      ? "none"
      : "visible";
  const aboutComponent = badge ? "Badge" : "Copy";
  const titleProp =
    markets.length > 1
      ? `, props: { title: store.getEntry("pages", page.entry.locale, page.entry.path).data.title }`
      : "";

  const globalCssKey =
    options.globalCss === true ? `\n    css: ["./global.css"],` : "";
  const routingKey =
    options.noHeaders === true
      ? ""
      : `\n    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },`;
  const scriptsKey =
    options.workerScripts === true
      ? `\n    scripts: defineScripts({ scripts: [{ name: "analytics", src: "https://example.com/a.js" }, { name: "pixel", src: "https://example.com/p.js", strategy: "idle" }], pageTypes: { "/**": { pixel: "worker" } } }),`
      : "";
  const adapterImports =
    options.adapter === "refuse"
      ? `import { ConfigError } from ${JSON.stringify(join(CORE, "exit.ts"))};\n`
      : options.adapter === "toggle"
        ? `import { readFileSync } from "node:fs";\n`
        : "";
  const adapterKey =
    options.adapter === "refuse"
      ? `\n    adapter: {
      name: "fake-host",
      compile: () => {
        throw new ConfigError('Edge target "fake-host": 2 faults:\\n  first fault\\n  second fault');
      },
    },`
      : options.adapter === "toggle"
        ? `\n    adapter: {
      name: "fake-host",
      compile: (routing) => {
        const flag = JSON.parse(readFileSync(${JSON.stringify(adapterFlagPath(ROOT))}, "utf8"));
        const artifacts = [];
        if (flag.includeTree) artifacts.push({ role: "tree-file", path: "/_redirects", contents: "tree\\n" });
        if (flag.includeEdge) artifacts.push({ role: "function", path: "worker.js", contents: "edge\\n" });
        return { artifacts };
      },
    },`
        : "";
  writeFileSync(
    join(ROOT, "pagedeck.config.ts"),
    `
${adapterImports}import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { defineScripts } from ${JSON.stringify(join(CORE, "scripts.ts"))};
import { SECURITY_HEADERS } from ${JSON.stringify(join(CORE, "routing.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(ROOT, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",${routingKey}${globalCssKey}${scriptsKey}${adapterKey}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ ${markets
        .map(
          (market) =>
            `${JSON.stringify(market.code)}: { label: ${JSON.stringify(market.code)}, direction: "ltr"${
              market.domain === undefined
                ? ""
                : `, domain: ${JSON.stringify(market.domain)}`
            } }`,
        )
        .join(", ")} }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Hero: { path: ${JSON.stringify(hero)}, hydrate: ${JSON.stringify(heroHydrate)} },
      Copy: { path: "./components/Copy.js"${copyHydrate} },${
        nested ? `\n      Wrap: "./components/Wrap.js",` : ""
      }${badge ? `\n      Badge: "design-kit",` : ""}${
        options.duplicateClientNames === true
          ? `\n      Banner: "./components/../components/Copy.js",`
          : ""
      }
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: (page, store) => (${
      nested
        ? `page.path === "/" ? { template: "Hero", props: {} } : { tree: [{ component: "Wrap" }] }`
        : options.templateMode === true
        ? `{ template: page.path === "/" ? "Hero" : "${aboutComponent}", props: {} }`
        : `{ tree: [{ component: page.path === "/" ? "Hero" : "${aboutComponent}"${titleProp} }] }`
    }),
  },
});
`,
  );
  return ROOT;
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Run {
  code: number;
  out: string;
  err: string;
}

// Imported per call: `buildTwice` resets the registry, and a `ConfigError` from
// another registry is not the class `isWiringFault` checks.
async function run(cwd: string, ...argv: string[]): Promise<Run> {
  const { runCli } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function assetUrls(html: string): string[] {
  return [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g),
    ...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g),
  ].map((match) => match[1] as string);
}

// All three quote characters: the minifier writes a dynamic import's specifier as
// a template literal.
function entryBundle(dist: string, html: string): string {
  const queue = assetUrls(html).filter((url) => url.endsWith(".js"));
  const seen = new Set<string>();
  const code: string[] = [];
  while (queue.length > 0) {
    const url = queue.shift() as string;
    if (seen.has(url)) continue;
    seen.add(url);
    const text = readFileSync(join(dist, url), "utf8");
    code.push(text);
    for (const match of text.matchAll(/["'`](\.\/[^"'`\s]+\.js)["'`]/g)) {
      queue.push(join(dirname(url), match[1] as string));
    }
  }
  return code.join("\n");
}

test("pagedeck build writes a site, a manifest and a routing document from a store", async () => {
  const dir = site();
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  expect(existsSync(join(dist, "index.html"))).toBe(true);
  expect(existsSync(join(dist, "about", "index.html"))).toBe(true);
  expect(readFileSync(join(dist, "index.html"), "utf8")).toContain(
    "marker-hero-41bd",
  );

  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  expect(manifest.routing.trees.length).toBeGreaterThan(0);
  expect(manifest.pages.map((page) => page.path)).toEqual(["/", "/about"]);
  expect(
    manifest.files.every((file) => existsSync(join(dist, file.path))),
  ).toBe(true);
  expect(manifest.files.some((file) => file.kind === "js")).toBe(true);
  // A site with no build.adapter writes exactly what it wrote before #20.
  expect(manifest.edge).toBeUndefined();
  expect(existsSync(join(dir, "edge"))).toBe(false);
}, 120_000);

test("every URL the emitted HTML references is a file the build wrote", async () => {
  const dir = site();
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const urls = assetUrls(readFileSync(join(dist, "index.html"), "utf8"));

  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url.startsWith("/")).toBe(true);
    expect(existsSync(join(dist, url))).toBe(true);
  }

  expect(
    assetUrls(readFileSync(join(dist, "about", "index.html"), "utf8")),
  ).toEqual([]);
}, 120_000);

test("two domain locales and one folder locale emit one output tree each", async () => {
  const dir = site({ markets: "domains" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const home = (tree: string) =>
    readFileSync(join(dist, tree, "index.html"), "utf8");
  expect(home(".")).toContain('lang="en"');
  expect(home("de.example.com")).toContain('lang="de"');
  expect(home("fr.example.com")).toContain('lang="fr"');
  expect(
    readFileSync(join(dist, "fr.example.com", "about", "index.html"), "utf8"),
  ).toContain('lang="fr"');

  expect(existsSync(join(dist, "de", "index.html"))).toBe(false);
  expect(existsSync(join(dist, "fr", "index.html"))).toBe(false);

  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  const documentsPerTree = new Map<string, number>();
  for (const file of manifest.files) {
    if (file.kind !== "html") continue;
    const tree = file.domain ?? "";
    documentsPerTree.set(tree, (documentsPerTree.get(tree) ?? 0) + 1);
  }
  expect([...documentsPerTree].sort()).toEqual([
    ["", 2],
    ["de.example.com", 2],
    ["fr.example.com", 2],
  ]);
}, 120_000);

test("every URL a domain locale's HTML references is a file inside that domain's tree", async () => {
  const dir = site({ markets: "domains" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  for (const tree of [".", "de.example.com", "fr.example.com"]) {
    const root = join(dist, tree);
    const urls = assetUrls(readFileSync(join(root, "index.html"), "utf8"));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(true);
      expect(existsSync(join(root, url))).toBe(true);
    }
  }

  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  const shared = manifest.files.filter(
    (file) => file.domain === "de.example.com" && file.kind === "js",
  );
  const inEveryTree = shared.filter((file) =>
    ["", "de.example.com", "fr.example.com"].every((tree) =>
      existsSync(join(dist, tree, file.path)),
    ),
  );
  expect(inEveryTree.length).toBeGreaterThan(0);
  for (const file of inEveryTree) {
    expect(
      manifest.files
        .filter((row) => row.path === file.path)
        .map((row) => row.hash),
    ).toEqual([file.hash, file.hash, file.hash]);
  }
}, 120_000);

test("two locales sharing one domain coexist in one tree, each under its own prefix", async () => {
  const dir = site({ markets: "sharedDomain" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const tree = join(dir, "dist", "example.ch");
  expect(readFileSync(join(tree, "de-ch", "index.html"), "utf8")).toContain(
    'lang="de-ch"',
  );
  expect(
    readFileSync(join(tree, "fr-ch", "about", "index.html"), "utf8"),
  ).toContain('lang="fr-ch"');
  expect(existsSync(join(tree, "index.html"))).toBe(false);

  const urls = assetUrls(
    readFileSync(join(tree, "de-ch", "index.html"), "utf8"),
  );
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(existsSync(join(tree, url))).toBe(true);
  }
}, 120_000);

test("an edit to one market's content diffs into that market's tree alone", async () => {
  const dir = site({ markets: "domains" });
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const read = () =>
    readManifest(
      readFileSync(join(dist, "manifest.json"), "utf8"),
      "manifest.json",
    );
  const before = read();

  writeFileSync(
    join(dir, "content", "de", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "Uber uns" } })}\n`,
  );
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const diff = diffManifests({ from: before, to: read() });

  const touched = diff.trees
    .filter((tree) => tree.upload.length > 0 || tree.prune.length > 0)
    .map((tree) => tree.domain);
  expect(touched).toEqual(["de.example.com"]);

  const de = diff.trees.find((tree) => tree.domain === "de.example.com");
  expect(de?.upload.map((file) => file.path)).toEqual(["/about/index.html"]);
  expect(de?.upload[0]?.change).toBe("changed");
  expect(
    readFileSync(join(dist, "de.example.com", "about", "index.html"), "utf8"),
  ).toContain("Uber uns");
}, 240_000);

test('a "use client" module the registry says nothing about islands and ships', async () => {
  const dir = site({ useClient: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(about).toContain("<fw-island");
  const urls = assetUrls(about);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(existsSync(join(dir, "dist", url))).toBe(true);
  }
  expect(entryBundle(join(dir, "dist"), about)).toContain("marker-copy-7c02");
}, 120_000);

test('a "use client" template component islands and ships in template mode', async () => {
  const dir = site({ useClient: true, templateMode: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(about).toContain("<fw-island");
  expect(entryBundle(join(dir, "dist"), about)).toContain("marker-copy-7c02");
}, 120_000);

function markers(html: string, component: string): string[] {
  return [...html.matchAll(/<fw-island\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes(`data-fw-component="${component}"`));
}

test('a "use client" component a template\'s own code renders islands and ships', async () => {
  const dir = site({ useClient: true, nestedClient: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const home = readFileSync(join(dir, "dist", "index.html"), "utf8");
  const found = markers(home, "Copy");
  expect(found.length).toBe(2);

  const prefixes = found.map(
    (marker) => /data-fw-prefix="([^"]*)"/.exec(marker)?.[1],
  );
  expect(prefixes[0]).toBeDefined();
  expect(new Set(prefixes).size).toBe(2);

  const manifest = readManifest(
    readFileSync(join(dir, "dist", "manifest.json"), "utf8"),
    "manifest.json",
  );
  expect(
    manifest.pages
      .filter((entry) => entry.path === "/")
      .flatMap((entry) => entry.components.map((component) => component.name)),
  ).toContain("Copy");
  expect(entryBundle(join(dir, "dist"), home)).toContain("marker-copy-7c02");
}, 120_000);

test('a "use client" component an ordinary component\'s code renders islands and ships', async () => {
  const dir = site({ useClient: true, nestedClient: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(about).toContain("marker-wrap-8d1c");
  expect(markers(about, "Copy").length).toBe(1);
  expect(entryBundle(join(dir, "dist"), about)).toContain("marker-copy-7c02");

  expect(about).toContain("marker-plain-5ab3");
  expect(markers(about, "Plain")).toEqual([]);
  expect(entryBundle(join(dir, "dist"), about)).not.toContain(
    "marker-plain-5ab3",
  );
}, 120_000);

test('a "use client" component the entry names is islanded once, not twice', async () => {
  const dir = site({ useClient: true });
  await run(dir, "sync");

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(markers(about, "Copy").length).toBe(1);
}, 120_000);

test('a reachable "use server" module fails the real build with exit 2', async () => {
  const dir = site({ useServer: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    '1 module carrying "use server" is reached by a rendered entry',
  );
  expect(result.err).toContain(join(dir, "components", "Copy.js"));
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test("a component with no directive and no registry hydrate ships no marker and no JavaScript", async () => {
  const dir = site();
  await run(dir, "sync");

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(about).not.toContain("<fw-island");
  expect(assetUrls(about)).toEqual([]);
}, 120_000);

test('a registry hydrate: "none" over a "use client" module fails the real build', async () => {
  const dir = site({ useClient: true, staticCopy: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    'Component "Copy": its module carries "use client" but the registry declares hydrate: "none", and entry /en/about renders it — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module',
  );
  expect(existsSync(join(dir, "dist", "about", "index.html"))).toBe(false);
}, 120_000);

test('a registry hydrate: "none" over a nested "use client" module fails the real build', async () => {
  const dir = site({ useClient: true, nestedClient: true, staticCopy: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    'Component "Copy": its module carries "use client" but the registry declares hydrate: "none", and "Hero" renders it in entry /en/ — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module',
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test('a registry hydrate: "none" with no directive ships static and says nothing', async () => {
  const dir = site({ staticCopy: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);
  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(about).toContain("marker-copy-7c02");
  expect(about).not.toContain("<fw-island");
  expect(assetUrls(about)).toEqual([]);
}, 120_000);

test('a registry hydrate: "none" over the root page names the root entry', async () => {
  const dir = site({ staticHero: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    'Component "Hero": its module carries "use client" but the registry declares hydrate: "none", and entry /en/ renders it — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module',
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test('a "use client" module inside a package is seen, not skipped as external', async () => {
  const dir = site({ packageIsland: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);

  const about = readFileSync(join(dir, "dist", "about", "index.html"), "utf8");
  expect(about).toContain("<fw-island");
  expect(about).toContain("marker-badge-9e55");
  expect(assetUrls(about).length).toBeGreaterThan(0);
  expect(entryBundle(join(dir, "dist"), about)).toContain("marker-badge-9e55");
}, 120_000);

test("a component path that names no file fails the build at load, naming the component", async () => {
  const dir = site({ danglingSpecifier: true });

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    [
      `Config "${join(dir, "pagedeck.config.ts")}": 1 component declares a module that does not resolve — point its path at a file, relative to this config file, or install the package its specifier names:`,
      `  "Hero" — "./components/Missing.js" resolves to "${join(dir, "components", "Missing.js")}", and no file is there`,
    ].join("\n"),
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test("a component module that will not parse fails the real build with exit 2", async () => {
  const dir = site({ unparsable: "copy" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    'Island scan: 1 component module will not parse, so the scan cannot tell whether a "use client" boundary is declared — fix the syntax error the parser names:',
  );
  expect(result.err).toContain(`  "${join(dir, "components", "Copy.js")}"`);
  expect(result.err).toContain("Expected `}` but found `EOF`");
  expect(result.err).toContain(
    `    1: export default function Copy() { return "marker-copy-7c02";`,
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test("two component modules that will not parse are both named in one run", async () => {
  const dir = site({ unparsable: "both" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    'Island scan: 2 component modules will not parse, so the scan cannot tell whether a "use client" boundary is declared — fix the syntax error the parser names in each:',
  );
  const copy = result.err.indexOf(`  "${join(dir, "components", "Copy.js")}"`);
  const hero = result.err.indexOf(`  "${join(dir, "components", "Hero.js")}"`);
  expect(copy).toBeGreaterThan(-1);
  expect(hero).toBeGreaterThan(-1);
  expect(copy).toBeLessThan(hero);
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test("a build the bundler itself fails still exits 1", async () => {
  const dir = site({ missingImport: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).toContain("Nowhere.js");
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test('a "use client" module registered under two names fails the real build with exit 2', async () => {
  const dir = site({ useClient: true, duplicateClientNames: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toBe(
    [
      'Island scan: 1 module carrying "use client" is registered under more than one component name, so a rendered instance of it cannot be told which name it is — register it under one name, or give each name a module of its own:',
      `  "${join(dir, "components", "Copy.js")}" — "Banner", "Copy"`,
    ].join("\n"),
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(false);
}, 120_000);

test("a preinit import inside a client closure warns and still builds", async () => {
  const dir = site({ preinitInEffect: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    [
      'Island scan: 1 module in a "use client" closure imports preinit or preinitModule from react-dom — a preinit call places a stylesheet past the <head> tiers the build owns, which the build refuses when the rendered HTML shows it; this is a warning and not a refusal because a call made from an effect leaves nothing in the HTML to see, and an import reached through a re-export or an alias leaves nothing here to see either:',
      `  "${join(dir, "components", "Copy.js")}" — preinit`,
      ABSENT_FAVICON,
    ].join("\n"),
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(true);
}, 120_000);

test("a stylesheet only a static component imports warns and still builds", async () => {
  const dir = site({ staticCss: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    [
      "Island scan: 1 stylesheet is imported only by modules outside every island's import closure, so no page links it — import the stylesheet from an island's module, or list it in build.css; this is a warning and not a refusal because every page still renders, and a page may link a stylesheet some other way the scan cannot see, such as a head link to a passthrough file:",
      `  "${join(dir, "global.css")}" — imported by "${join(dir, "components", "Copy.js")}"`,
      ABSENT_FAVICON,
    ].join("\n"),
  );
  expect(existsSync(join(dir, "dist", "index.html"))).toBe(true);
}, 120_000);

test("a stylesheet a static component imports and build.css lists does not warn", async () => {
  const dir = site({ staticCss: true, globalCss: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(ABSENT_FAVICON);
}, 120_000);

test('an unregistered "use client" module a static component imports warns and still builds', async () => {
  const dir = site({ unregisteredClient: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    [
      `Island scan: 1 module carrying "use client" is imported from outside every island but is not registered in build.components, so it renders as static HTML with no JavaScript — register it under build.components, or import it only from an island's module; this is a warning and not a refusal because an import is not a render, and a client module can render correctly as static HTML:`,
      `  "${join(dir, "components", "Toggle.js")}" — ${join(dir, "components", "Copy.js")} → ${join(dir, "components", "Toggle.js")}`,
      ABSENT_FAVICON,
    ].join("\n"),
  );
  expect(
    readFileSync(join(dir, "dist", "about", "index.html"), "utf8"),
  ).toContain("marker-toggle-3f6a");
}, 120_000);

test("a site with no islands compiles and links its global stylesheet, and ships no JavaScript", async () => {
  const dir = site({ globalCss: true, noIslands: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(ABSENT_FAVICON);
  const dist = join(dir, "dist");
  for (const page of ["index.html", join("about", "index.html")]) {
    const html = readFileSync(join(dist, page), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)];
    expect(links.map(([, href]) => href)).toEqual([
      expect.stringMatching(/^\/assets\/[^/]+\.css$/),
    ]);
    const href = (links[0] as RegExpMatchArray)[1] as string;
    expect(readFileSync(join(dist, href), "utf8")).toContain(".fw-global");
    expect(html).not.toContain("<script");
  }
  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  expect(manifest.files.filter((file) => file.kind === "js")).toEqual([]);
  expect(readdirSync(join(dist, "assets")).filter((name) => name.endsWith(".js"))).toEqual([]);
}, 120_000);

test("a site that declares no header set is warned once, and still builds", async () => {
  const dir = site({ noHeaders: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    [
      'Security headers: this site declares no header set, so no response its output serves carries one — build.routing.headers is the only place a generated site can put a response header, and with the field absent no _headers file, no nginx add_header block and no CloudFront viewer-response function is emitted at all; this is a warning and not a refusal because every page this build emitted is correct and a host that already sets these headers would be handed duplicates by a default nobody wrote — spread SECURITY_HEADERS into the set of a rule over "/", which is these three, or declare a set of your own to say the host is doing it:',
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      ABSENT_FAVICON,
    ].join("\n"),
  );
  const manifest = readManifest(
    readFileSync(join(dir, "dist", "manifest.json"), "utf8"),
    "manifest.json",
  );
  expect(manifest.routing.trees.every((tree) => tree.headers.length === 0)).toBe(
    true,
  );
}, 120_000);

test("a site whose scripts reach worker with no runtime is warned once", async () => {
  const dir = site({ workerScripts: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    [
      'Script runtime: 2 scripts can resolve to the worker strategy and this site configures no script runtime, so each of them loads on idle instead — worker moves a script off the main thread, and core ships no mechanism to do that with because a framework that picked one would carry a vendor\'s runtime into every site that never asked for it; this is a warning and not a refusal because idle is the fallback spec §12 states for this case, and a site that did not want off-main-thread loading is served correctly by it — supply build.scripts.runtime, or declare strategy: "idle" to say the fallback is what you meant:',
      '  "analytics" — declares no strategy, so it takes the worker default',
      '  "pixel" — pageTypes "/**" sets "worker"',
      ABSENT_FAVICON,
    ].join("\n"),
  );
  const home = readFileSync(join(dir, "dist", "index.html"), "utf8");
  expect(home).toContain("https://example.com/a.js");
  expect(home).toContain("https://example.com/p.js");
  expect(home).toContain("requestIdleCallback");
  expect(home).not.toContain("worker");
  expect(home).not.toContain("partytown");
}, 120_000);

test("a site that hydrates one component compiles its global stylesheet", async () => {
  const dir = site({ globalCss: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(ABSENT_FAVICON);
  const sheets = assetUrls(
    readFileSync(join(dir, "dist", "index.html"), "utf8"),
  ).filter((url) => url.endsWith(".css"));
  expect(sheets).toHaveLength(1);
  const sheet = readFileSync(join(dir, "dist", sheets[0] as string), "utf8");
  expect(sheet).toContain(".fw-global");
}, 120_000);

function eagerJoin(input: {
  ids: Record<string, string>;
  modules: ReadonlyMap<string, readonly string[]>;
}): Map<string, readonly string[]> {
  const plan: EntryPlan = {
    entries: [
      {
        locale: "en",
        path: "/pricing",
        id: "\0fw:entry/en/pricing",
        name: "en/pricing",
        components: [
          { name: "Chart", module: "./src/Chart.js", eager: true },
          { name: "Nav", module: "./src/Nav.js", eager: false },
        ],
      },
    ],
    contentOnly: [],
  };
  const client: ClientBuild = {
    files: [],
    entryScripts: new Map(),
    entryStyles: new Map(),
    globalStyles: [],
    modules: input.modules,
    imports: new Map(),
    ids: input.ids,
    warnings: [],
  };
  return eagerChunksByPage(plan, client);
}

test("an eager island whose id no chunk holds is refused, not counted as nothing", () => {
  const chart = "/site/src/Chart.js";

  expect(
    eagerJoin({
      ids: { "./src/Chart.js": chart, "./src/Nav.js": "/site/src/Nav.js" },
      modules: new Map([["/assets/Chart-9f31.js", [chart]]]),
    }),
  ).toEqual(new Map([["en /pricing", ["/assets/Chart-9f31.js"]]]));

  expect(() =>
    eagerJoin({
      ids: { "./src/Chart.js": chart, "./src/Nav.js": "/site/src/Nav.js" },
      modules: new Map([["/assets/en_pricing-1a2b.js", ["/site/src/Nav.js"]]]),
    }),
  ).toThrow(
    new ConfigError(
      [
        'JavaScript budget: 1 eagerly hydrated island resolved to a module no emitted chunk holds, so the page it is on would be charged nothing for it — check the module map names a module this build bundles, and report it with the id below if it does:',
        `  en /pricing "Chart" — "./src/Chart.js" resolved to "${chart}"`,
      ].join("\n"),
    ),
  );
});

function fileCount(root: string): number {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile(),
  ).length;
}

// Top-level imports stay bound to the registry before the first reset: a test that
// compares one with a `run()` result goes above these, or imports inside.
async function buildTwice(dir: string): Promise<readonly OutputDifference[]> {
  const dist = join(dir, "dist");
  const first = join(dir, "dist-first");
  await buildInFreshRegistry(dir);
  renameSync(dist, first);
  await buildInFreshRegistry(dir);

  expect(fileCount(first)).toBeGreaterThan(0);
  expect(fileCount(dist)).toBeGreaterThan(0);
  return diffOutputTrees(first, dist);
}

async function buildInFreshRegistry(dir: string): Promise<void> {
  vi.resetModules();
  const { runCli: fresh } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await fresh(["build"], {
    cwd: dir,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  expect(err.join("\n")).toBe(ABSENT_FAVICON);
  expect(code).toBe(EXIT_CODES.success);
}

test("two builds of one unchanged site emit byte-identical output", async () => {
  const dir = site({ reloadable: true });
  await run(dir, "sync");

  const differences = await buildTwice(dir);

  expect(
    differences.length === 0
      ? ""
      : outputDifferenceReport(
          { first: join(dir, "dist-first"), second: join(dir, "dist") },
          differences,
        ),
  ).toBe("");
}, 240_000);

test("a component that renders a random value fails the build-twice check by name", async () => {
  const dir = site({ nondeterministicCopy: true, reloadable: true });
  await run(dir, "sync");

  const differences = await buildTwice(dir);

  expect(differences).toContainEqual({
    path: "about/index.html",
    difference: "bytes",
  });
  expect(
    outputDifferenceReport(
      { first: join(dir, "dist-first"), second: join(dir, "dist") },
      differences,
    ),
  ).toContain("about/index.html — the bytes differ");
  expect(differences.map((entry) => entry.path)).toContain("manifest.json");
}, 240_000);

function documentWith(content: string, foot: readonly string[]): string {
  return [
    "<!doctype html>",
    '<html lang="en" dir="ltr">',
    "<head>",
    '<meta charset="utf-8">',
    "</head>",
    "<body>",
    "<main>",
    content,
    "</main>",
    ...foot,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function textOf(element: string): string {
  return element.slice("<script>".length, -"</script>".length);
}

const IDENTITY = { locale: "en", path: "/" };

const LOADER =
  scriptElements(
    {
      scripts: [
        { name: "metrics", src: "https://example.com/metrics.js", strategy: "idle" },
      ],
    },
    IDENTITY,
  ).elements.at(-1) ?? "";

const BEACON =
  beaconElement({ endpoint: "https://collector.example/rum" }, undefined, IDENTITY) ??
  "";

test("the foot's loader and beacon are read whole behind a runtime <script src>", () => {
  const src = '<script type="text/partytown" src="https://example.com/tags.js"></script>';
  expect(LOADER.startsWith("<script>(function(){")).toBe(true);

  expect(coreInlineScripts(documentWith("<p>Copy</p>", [src, LOADER, BEACON]))).toEqual(
    [textOf(LOADER), textOf(BEACON)],
  );
  expect(coreInlineScripts(documentWith("<p>Copy</p>", [src, LOADER]))).toEqual([
    textOf(LOADER),
  ]);
});

test("a page with a module script and no loader lists no loader, whatever its content holds", () => {
  const content = LOADER;
  const module = '<script type="module" src="/assets/page-1a2b.js"></script>';

  expect(coreInlineScripts(documentWith(content, [module]))).toEqual([]);
  expect(coreInlineScripts(documentWith(content, [module, BEACON]))).toEqual([
    textOf(BEACON),
  ]);
});

function unprunedTree(dist: string, ...lines: readonly string[]): string {
  return [
    ABSENT_FAVICON,
    `Output "${dist}": this build removed no file an earlier build wrote there, because the manifest.json it left is not one this build can prune against — a full build deletes each file the previous build's manifest names and its own does not, and without that document it cannot tell a file an earlier build wrote from one placed there by hand, so a page that build published and this one did not, such as a post set to draft since, may still be in the directory; this is a warning and not a refusal because every file this build wrote is correct and the manifest it wrote is the one the next build prunes against — before a deploy that syncs this directory, delete the pages that build published and this one did not, or point build.outDir at a new, empty directory and build again; a deploy that reads the manifest needs neither:`,
    ...lines.map((line) => `  ${line}`),
  ].join("\n");
}

test("build.adapter's tree-file artifacts land in the output tree and its other artifacts land in edge/, beside it", async () => {
  const dir = site({ adapter: "toggle" });
  const dist = join(dir, "dist");
  writeFileSync(
    adapterFlagPath(dir),
    JSON.stringify({ includeTree: true, includeEdge: true }),
  );
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe(ABSENT_FAVICON);
  expect(result.code).toBe(EXIT_CODES.success);
  expect(readFileSync(join(dist, "_redirects"), "utf8")).toBe("tree\n");
  expect(readFileSync(join(dir, "edge", "worker.js"), "utf8")).toBe("edge\n");

  const manifest = readManifest(
    readFileSync(join(dist, MANIFEST_FILE), "utf8"),
    MANIFEST_FILE,
  );
  expect(manifest.files.some((file) => file.path === "/_redirects")).toBe(true);
  expect(manifest.edge).toEqual({
    target: "fake-host",
    files: [{ path: "worker.js" }],
  });
}, 120_000);

test("a refusing adapter fails pagedeck build with every fault and the config error exit code", async () => {
  const dir = site({ adapter: "refuse" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain('Edge target "fake-host"');
  expect(result.err).toContain("first fault");
  expect(result.err).toContain("second fault");
}, 120_000);

test("an incremental build runs the adapter again and writes the same edge files", async () => {
  const dir = site({ adapter: "toggle" });
  const dist = join(dir, "dist");
  writeFileSync(
    adapterFlagPath(dir),
    JSON.stringify({ includeTree: true, includeEdge: true }),
  );
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  writeFileSync(
    join(dir, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "About, again" } })}\n`,
  );
  await run(dir, "sync");
  const result = await run(dir, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(readFileSync(join(dist, "_redirects"), "utf8")).toBe("tree\n");
  expect(readFileSync(join(dir, "edge", "worker.js"), "utf8")).toBe("edge\n");
}, 120_000);

test("a build whose adapter stops writing an artifact removes it from the output tree and from edge/", async () => {
  const dir = site({ adapter: "toggle" });
  const dist = join(dir, "dist");
  const flag = adapterFlagPath(dir);
  writeFileSync(flag, JSON.stringify({ includeTree: true, includeEdge: true }));
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);
  expect(existsSync(join(dist, "_redirects"))).toBe(true);
  expect(existsSync(join(dir, "edge", "worker.js"))).toBe(true);

  writeFileSync(flag, JSON.stringify({ includeTree: false, includeEdge: false }));
  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(join(dist, "_redirects"))).toBe(false);
  expect(existsSync(join(dir, "edge", "worker.js"))).toBe(false);
  const manifest = readManifest(
    readFileSync(join(dist, MANIFEST_FILE), "utf8"),
    MANIFEST_FILE,
  );
  expect(manifest.edge).toEqual({ target: "fake-host", files: [] });
}, 120_000);

test("a full build removes what the previous build wrote and this one did not, and keeps a file placed by hand", async () => {
  const dir = site();
  const dist = join(dir, "dist");
  await run(dir, "sync");
  const first = await run(dir, "build");
  expect(first.err).toBe(ABSENT_FAVICON);
  const before = readManifest(
    readFileSync(join(dist, MANIFEST_FILE), "utf8"),
    MANIFEST_FILE,
  );
  expect(existsSync(join(dist, "about", "index.html"))).toBe(true);
  writeFileSync(join(dist, "verify.txt"), "placed by hand\n");

  writeFileSync(
    join(dir, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, deleted: true })}\n`,
  );
  await run(dir, "sync");
  const second = await run(dir, "build");

  expect(second.code).toBe(EXIT_CODES.success);
  expect(second.err).toBe(ABSENT_FAVICON);
  const after = readManifest(
    readFileSync(join(dist, MANIFEST_FILE), "utf8"),
    MANIFEST_FILE,
  );
  expect(after.pages.map((page) => page.path)).toEqual(["/"]);
  const kept = new Set(after.files.map((file) => file.path));
  const dropped = before.files.filter((file) => !kept.has(file.path));
  expect(dropped.map((file) => file.path)).toContain("/about/index.html");
  for (const file of dropped) {
    expect(existsSync(join(dist, file.path)), file.path).toBe(false);
  }
  for (const file of after.files) {
    expect(existsSync(join(dist, file.path)), file.path).toBe(true);
  }
  expect(readFileSync(join(dist, "verify.txt"), "utf8")).toBe(
    "placed by hand\n",
  );
}, 240_000);

test("a full build over a manifest.json that is not JSON builds, removes nothing and warns once", async () => {
  const dir = site();
  const dist = join(dir, "dist");
  await run(dir, "sync");
  mkdirSync(join(dist, "stale"), { recursive: true });
  writeFileSync(join(dist, "stale", "index.html"), "<p>stale</p>\n");
  writeFileSync(join(dist, MANIFEST_FILE), "not json");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  const file = join(dist, MANIFEST_FILE);
  expect(result.err).toMatch(
    new RegExp(
      `^${escapeRegExp(
        unprunedTree(
          dist,
          `Manifest "${file}": is not valid JSON — pagedeck build writes it, so re-run the build that produced it: `,
        ),
      )}[^\\n]+$`,
    ),
  );
  expect(existsSync(join(dist, "stale", "index.html"))).toBe(true);
  expect(() =>
    readManifest(readFileSync(file, "utf8"), file),
  ).not.toThrow();
}, 120_000);

test("a full build over a manifest.json of another version builds, removes nothing and warns once", async () => {
  const dir = site();
  const dist = join(dir, "dist");
  await run(dir, "sync");
  mkdirSync(join(dist, "stale"), { recursive: true });
  writeFileSync(join(dist, "stale", "index.html"), "<p>stale</p>\n");
  const file = join(dist, MANIFEST_FILE);
  writeFileSync(
    file,
    JSON.stringify({
      version: MANIFEST_VERSION - 1,
      files: [{ path: "/stale/index.html" }],
    }),
  );

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": is version ${String(MANIFEST_VERSION - 1)}, and this build reads version ${String(MANIFEST_VERSION)} — upgrade pagedeck, or read a manifest this version wrote`,
    ),
  );
  expect(existsSync(join(dist, "stale", "index.html"))).toBe(true);
}, 120_000);

async function rebuiltOver(
  files: unknown,
  prepare: (dist: string, dir: string) => void = () => undefined,
): Promise<{ dist: string; file: string; sentinel: string; result: Run }> {
  const dir = site();
  const dist = join(dir, "dist");
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);
  const sentinel = join(dir, "sentinel.txt");
  writeFileSync(sentinel, "outside the tree\n");
  prepare(dist, dir);
  const file = join(dist, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const rows = Array.isArray(files)
    ? files.map((row: unknown) =>
        typeof row === "object" && row !== null
          ? { kind: "asset", hash: "sha256:0", size: 0, ...row }
          : row,
      )
    : files;
  writeFileSync(file, JSON.stringify({ ...manifest, files: rows }));
  return { dist, file, sentinel, result: await run(dir, "build") };
}

test("a full build over a manifest whose row climbs out of the tree by its path deletes nothing outside it and warns once", async () => {
  const { file, dist, sentinel, result } = await rebuiltOver([
    { path: "/../sentinel.txt" },
  ]);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(sentinel)).toBe(true);
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files[0]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "/../sentinel.txt"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    ),
  );
}, 240_000);

test("a full build over a manifest whose row climbs out of the tree by its domain deletes nothing outside it and warns once", async () => {
  const { file, dist, sentinel, result } = await rebuiltOver([
    { domain: "..", path: "/sentinel.txt" },
  ]);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(sentinel)).toBe(true);
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files[0]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "//../sentinel.txt"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    ),
  );
}, 240_000);

test("a full build over a manifest of this version with no files list builds and warns once", async () => {
  const { file, dist, result } = await rebuiltOver(undefined);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files: expected a list, found nothing), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    ),
  );
}, 240_000);

test.skipIf(process.platform === "win32")(
  "a full build over a manifest whose row reaches out of the tree through a symbolic link deletes nothing outside it and warns once",
  async () => {
    const { file, dist, sentinel, result } = await rebuiltOver(
      [{ path: "/link/sentinel.txt" }],
      (tree, dir) => symlinkSync(dir, join(tree, "link")),
    );

    expect(result.code).toBe(EXIT_CODES.success);
    expect(existsSync(sentinel)).toBe(true);
    expect(result.err).toBe(
      unprunedTree(
        dist,
        `Manifest "${file}": files row 0 names "/link/sentinel.txt", which resolves outside the output directory through a symbolic link — pagedeck build writes only paths inside it, so this row was not written by a build`,
      ),
    );
  },
  240_000,
);

test("a full build over a manifest whose row names a directory keeps it and warns once", async () => {
  const { file, dist, result } = await rebuiltOver(
    [{ path: "/kept" }, { domain: "kept", path: "" }],
    (tree) => {
      mkdirSync(join(tree, "kept"));
      writeFileSync(join(tree, "kept", "inside.txt"), "kept\n");
    },
  );

  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(join(dist, "kept", "inside.txt"))).toBe(true);
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": files row 0 names "/kept", which is not a regular file — pagedeck build writes only regular files, so this row was not written by a build`,
      `Manifest "${file}": files row 1 names "" in domain "kept", which is not a regular file — pagedeck build writes only regular files, so this row was not written by a build`,
    ),
  );
}, 240_000);

test("a full build over a manifest whose row holds a NUL character prunes nothing and warns once", async () => {
  const { file, dist, result } = await rebuiltOver(
    [{ path: "/about/stale.html" }, { path: "/x\u0000y" }],
    (tree) => writeFileSync(join(tree, "about", "stale.html"), "stale\n"),
  );

  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(join(dist, "about", "stale.html"))).toBe(true);
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": 1 field does not hold what pagedeck build writes there (files[1]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "/x\\u0000y"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    ),
  );
}, 240_000);

test("a full build over a manifest whose row names the manifest itself keeps the one it wrote and warns once", async () => {
  const { file, dist, result } = await rebuiltOver([{ path: "/manifest.json" }]);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(() => readManifest(readFileSync(file, "utf8"), file)).not.toThrow();
  expect(result.err).toBe(
    unprunedTree(
      dist,
      `Manifest "${file}": files row 0 names "/manifest.json", which is the manifest this build writes — pagedeck build never lists its own manifest as a file, so this row was not written by a build`,
    ),
  );
}, 240_000);

// Write-only, not a directory: a directory fails the build's own manifest write
// before any warning is written.
test.skipIf(process.getuid?.() === 0)(
  "a full build over a manifest.json it cannot open builds, removes nothing and warns once",
  async () => {
    const dir = site();
    const dist = join(dir, "dist");
    await run(dir, "sync");
    mkdirSync(dist, { recursive: true });
    const file = join(dist, MANIFEST_FILE);
    writeFileSync(file, "{}");
    chmodSync(file, 0o200);

    const result = await run(dir, "build");

    expect(result.code).toBe(EXIT_CODES.success);
    expect(result.err).toBe(
      unprunedTree(
        dist,
        `Manifest "${file}": could not be opened (EACCES), so which files the earlier build wrote cannot be read from it — make it a file this build can read, or delete it`,
      ),
    );
  },
  120_000,
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a pass that finds reused pages naming moved chunks stages again with those pages to render, and a settled pass ends it", async () => {
  const seen: Map<string, string>[] = [];
  const site = await stageUntilSettled(async (rerender) => {
    seen.push(new Map(rerender));
    return seen.length === 1
      ? { kind: "moved", moved: [{ page: "en /signup", href: "/assets/entry-OLD.js" }] }
      : { kind: "built", site: "staged" };
  });

  expect(site).toBe("staged");
  expect(seen).toEqual([new Map(), new Map([["en /signup", "/assets/entry-OLD.js"]])]);
});

test("a build whose third bundle still moves a reused page's chunk refuses after it, naming the page and the chunk", async () => {
  let passes = 0;
  const failure = await stageUntilSettled(async () => {
    passes += 1;
    return {
      kind: "moved",
      moved: [{ page: `en /p${String(passes)}`, href: `/assets/entry-${String(passes)}.js` }],
    };
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(passes).toBe(3);
  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toBe(
    'Site build: 1 page this build reuses still names a chunk or stylesheet this build did not emit after 3 bundles — each bundle after the first renders again every reused page the one before found naming a file it did not emit, and an incremental build runs no more bundles than that — run pagedeck build to write the whole site again:\n  en /p3 — "/assets/entry-3.js"',
  );
});
