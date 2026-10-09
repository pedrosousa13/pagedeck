import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER, readManifest } from "@pagedeck/core";
import type { RoutingManifest } from "@pagedeck/core";
import { ABSENT_FAVICON } from "../../core/src/favicon.test-support.js";
import { netlify } from "./index.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-removal-build-test");
const OUT = join(SITE, "dist");

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

/** Absent until the full build has run, so that build sees every page. */
const REMOVED = join(SITE, "removed.json");

const CORPUS = [
  { path: "home", title: "Home" },
  { path: "docs", title: "Docs" },
  { path: "docs/old", title: "Old" },
];

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });
  writeFileSync(
    join(SITE, "components", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );

  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";

const CORPUS = ${JSON.stringify(CORPUS)};
const REMOVED = ${JSON.stringify(REMOVED)};

const upsertAll = (writer) => {
  for (const entry of CORPUS) {
    writer.upsert({ locale: "en", path: entry.path, data: { title: entry.title } });
  }
  return {
    changed: CORPUS.map(({ path }) => ({ locale: "en", path })),
    deleted: [],
    cursor: 1,
  };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: (writer) => upsertAll(writer),
    syncSince: (writer, cursor) => {
      if (cursor >= 2 || !existsSync(REMOVED)) return { changed: [], deleted: [], cursor };
      const deleted = JSON.parse(readFileSync(REMOVED, "utf8")).map((path) => ({ locale: "en", path }));
      for (const id of deleted) writer.delete(id);
      return { changed: [], deleted, cursor: 2 };
    },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    // A header set, so the build writes nothing of its own on stderr (#318).
    routing: {
      headers: [
        { prefix: "/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
      ],
    },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: { Prose: "./components/Prose.js" },
    content: (page, store) => ({
      tree: [
        {
          component: "Prose",
          props: {
            text: store.getEntry("pages", page.locale, page.entry.path).data.title,
          },
        },
      ],
    }),
  },
});
`,
  );
}

async function run(...argv: string[]): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, ...argv], {
    cwd: SITE,
  });
  expect(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  ).toBe(argv[0] === "build" ? `${DIAGNOSTIC_MARKER} ${ABSENT_FAVICON}` : "");
}

let routing: RoutingManifest;

beforeAll(async () => {
  writeSite();
  await run("sync");
  await run("build");
  writeFileSync(REMOVED, JSON.stringify(["docs/old"]));
  await run("sync", "--incremental");
  await run("build", "--incremental");
  const file = join(OUT, "manifest.json");
  routing = readManifest(readFileSync(file, "utf8"), file).routing;
}, 180_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("the incremental build wrote the removed page's redirect into the routing document", () => {
  expect(routing.trees.map((tree) => tree.redirects)).toEqual([
    [
      {
        from: "/docs/old",
        to: "/docs",
        status: 308,
        source: "deleted-page",
        via: [],
      },
    ],
  ]);
});

test("the netlify compiler turns the removed page's redirect into a _redirects row, status 301 for the document's 308 (#10)", () => {
  const output = netlify().compile(routing);

  const file = output.artifacts.find((one) => one.path === "/_redirects");
  expect(file?.contents).toContain("/docs/old /docs 301");
});
