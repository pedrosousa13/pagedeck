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

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "src"), { recursive: true });
  mkdirSync(join(SITE, "components"), { recursive: true });
  writeFileSync(join(SITE, "src", "scripts.ts"), documentedModule());
  writeFileSync(
    join(SITE, "components", "Prose.js"),
    "export default function Prose() { return \"marker-prose-41d7\"; }\n",
  );
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
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

async function run(verb: string): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  diagnostics.set(
    verb,
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  );
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
});

function documents(): Map<string, string> {
  return new Map(
    manifest.pages.map((page) => [page.path, readFileSync(join(OUT, page.html), "utf8")]),
  );
}

function snippetOf(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? "")
    .filter((text) => text.includes("text/partytown"));
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

test("each page's worker script is typed text/partytown, after the snippet, and not on the idle loader", () => {
  const pages = documents();
  expect([...pages.keys()].sort()).toEqual(["/", "/about"]);
  for (const html of pages.values()) {
    const element = '<script type="text/partytown" src="https://example.com/gtm.js"></script>';
    expect(html).toContain(element);
    expect(html.indexOf(`<script>${snippetOf(html)}</script>`)).toBeLessThan(html.indexOf(element));
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
    ["partytown-media.js", "partytown-sandbox-sw.html", "partytown-sw.js"].map((name) => ({
      path: `${lib}${name}`,
      kind: "asset",
      hashed: true,
    })),
  );
  for (const { path } of rows) {
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
