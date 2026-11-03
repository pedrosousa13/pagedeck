import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER, readManifest } from "@pagedeck/core";
import type { Manifest } from "@pagedeck/core";
import { libDirPath } from "@qwik.dev/partytown/utils";
import { ABSENT_FAVICON } from "../../core/src/favicon.test-support.js";
import type { PartytownRuntime } from "./partytown.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-partytown-build-test");
const OUT = join(SITE, "dist");
const RESOLVED_SITE = join(import.meta.dirname, "..", ".pagedeck-partytown-resolve-test");

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const PAGE = join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "reference",
  "third-party-scripts.md",
);

/** The first `ts` fence under the heading: the module the page has the reader write. */
function documentedModule(): string {
  const page = readFileSync(PAGE, "utf8");
  const heading = page.indexOf("\n### Run worker scripts on Partytown\n");
  expect(heading).toBeGreaterThan(-1);
  const open = page.indexOf("\n```ts\n", heading);
  const close = page.indexOf("\n```\n", open + 1);
  const module = page.slice(open + "\n```ts\n".length, close + 1);
  expect(module).toContain("definePartytown(");
  return module;
}

function writeSite(site = SITE, module = documentedModule()): void {
  rmSync(site, { recursive: true, force: true });
  mkdirSync(join(site, "src"), { recursive: true });
  mkdirSync(join(site, "components"), { recursive: true });
  writeFileSync(join(site, "src", "scripts.ts"), module);
  writeFileSync(
    join(site, "components", "Prose.js"),
    "export default function Prose() { return \"marker-prose-41d7\"; }\n",
  );
  writeFileSync(
    join(site, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";
import { scripts } from "./src/scripts.ts";

const PATHS = ["home", "about"];
const upsertAll = (writer) => {
  for (const path of PATHS) writer.upsert({ locale: "en", path, data: {} });
  return { changed: PATHS.map((path) => ({ locale: "en", path })), deleted: [], cursor: 1 };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: (writer) => upsertAll(writer),
    syncSince: (writer, cursor) =>
      cursor >= 1 ? { changed: [], deleted: [], cursor: 1 } : upsertAll(writer),
    fetchOne: () => ({}),
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    scripts,
    routing: {
      headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
      upstreams: [{ prefix: "/vendor/collector/" }],
    },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: { Prose: "./components/Prose.js" },
    content: () => ({ tree: [{ component: "Prose" }] }),
  },
});
`,
  );
}

const diagnostics = new Map<string, string>();

async function run(verb: string, cwd = SITE, ...flags: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, verb, ...flags], {
    cwd,
  });
  diagnostics.set(
    verb,
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  );
  return stdout;
}

let manifest: Manifest;

beforeAll(async () => {
  writeSite();
  await run("sync");
  await run("build");
  const file = join(OUT, "manifest.json");
  manifest = readManifest(readFileSync(file, "utf8"), file);
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(RESOLVED_SITE, { recursive: true, force: true });
});

function documents(): Map<string, string> {
  return new Map(
    manifest.pages.map((page) => [page.path, readFileSync(join(OUT, page.html), "utf8")]),
  );
}

function snippetOf(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? "")
    .filter((text) => text.includes("text/partytown") && text.includes("serviceWorker"));
  expect(scripts).toHaveLength(1);
  return scripts[0] ?? "";
}

function libOf(snippet: string): string {
  const window: Record<string, unknown> = {
    crossOriginIsolated: false,
    addEventListener: () => undefined,
  };
  runInNewContext(snippet, {
    window,
    top: window,
    navigator: { serviceWorker: {} },
    document: { readyState: "loading" },
  });
  return String((window["partytown"] as { lib?: unknown }).lib);
}

test("the build says nothing about worker falling back to idle", () => {
  expect(diagnostics.get("build")).toBe(`${DIAGNOSTIC_MARKER} ${ABSENT_FAVICON}`);
});

test("each page carries the snippet in its head, its worker script typed text/partytown in its body, and nothing on the idle loader", () => {
  const pages = documents();
  expect([...pages.keys()].sort()).toEqual(["/", "/about"]);
  for (const html of pages.values()) {
    const element = '<script type="text/partytown" src="https://example.com/gtm.js"></script>';
    expect(html).toContain(element);
    expect(html.indexOf(`<script>${snippetOf(html)}</script>`)).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf(element)).toBeGreaterThan(html.indexOf("<body>"));
    expect(html).not.toContain('load(["https://example.com/gtm.js"');
  }
});

test("Partytown's files are written once, hashed, under the directory the snippet loads them from", () => {
  const libs = [...documents().values()].map((html) => libOf(snippetOf(html)));
  const lib = libs[0] ?? "";
  expect(lib).toMatch(/^\/script-runtime\/[0-9a-f]{8}\/$/);
  expect(new Set(libs)).toEqual(new Set([lib]));

  const rows = manifest.files.filter((file) => file.path.startsWith("/script-runtime/"));
  expect(rows.map(({ path, kind, hashed }) => ({ path, kind, hashed }))).toEqual(
    [
      "partytown-config.txt",
      "partytown-media.js",
      "partytown-sandbox-sw.html",
      "partytown-sw.js",
    ].map((name) => ({
      path: `${lib}${name}`,
      kind: "asset",
      hashed: true,
    })),
  );
  for (const { path } of rows.filter(({ path }) => !path.endsWith(".txt"))) {
    const name = path.slice(lib.length);
    expect(readFileSync(join(OUT, path)).equals(readFileSync(join(libDirPath(), name)))).toBe(
      true,
    );
  }
});

test("the hash the runtime reports is the hash of the snippet every page carries", async () => {
  const { runtime } = (await import(join(SITE, "src", "scripts.ts"))) as {
    runtime: PartytownRuntime;
  };

  for (const html of documents().values()) {
    const digest = createHash("sha256").update(snippetOf(html), "utf8").digest("base64");
    expect(runtime.inlineScriptHash).toBe(`'sha256-${digest}'`);
  }
});

function resolvedModule(prefix: string): string {
  return `import { defineScripts } from "@pagedeck/core";
import { definePartytown } from "@pagedeck/script-worker";

export const scripts = defineScripts({
  scripts: [
    { name: "tags", src: "https://example.com/gtm.js" },
    { name: "pixel", src: "https://example.com/pixel.js", category: "analytics" },
  ],
  runtime: definePartytown({ resolveUrl: { "https://collector.example": ${JSON.stringify(prefix)} } }),
});
`;
}

test("an incremental build after only resolveUrl changes renders again every page the old snippet was on", async () => {
  writeSite(RESOLVED_SITE, resolvedModule("/vendor/collector/"));
  await run("sync", RESOLVED_SITE);
  await run("build", RESOLVED_SITE);
  writeFileSync(join(RESOLVED_SITE, "src", "scripts.ts"), resolvedModule("/vendor/collector-v2/"));

  expect(await run("build", RESOLVED_SITE, "--incremental")).toContain(
    "incremental: 2 of 2 pages rendered, 0 reused, 0 removed",
  );
  const dist = join(RESOLVED_SITE, "dist");
  const file = join(dist, "manifest.json");
  const built = readManifest(readFileSync(file, "utf8"), file);
  for (const page of built.pages) {
    const html = readFileSync(join(dist, page.html), "utf8");
    expect(html).toContain("/vendor/collector-v2/");
    expect(html).not.toContain('"/vendor/collector/"');
    expect(readFileSync(join(dist, libOf(snippetOf(html)), "partytown-sw.js")).length).toBeGreaterThan(0);
    // #281
    expect(html).not.toContain('type="text/partytown" src="https://example.com/pixel.js"');
    expect(html).toContain('[["https://example.com/pixel.js"],"analytics",0]');
  }
}, 240_000);
