import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER, readManifest } from "@pagedeck/core";
import type { RoutingManifest } from "@pagedeck/core";
import { vercel } from "./index.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-site-build-test");
const OUT = join(SITE, "dist");

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const MOVED = "/old-pricing";
const TARGET = "/pricing";

const CORPUS = [
  { path: "home", title: "Home" },
  { path: "pricing", title: "Pricing" },
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
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";

const CORPUS = ${JSON.stringify(CORPUS)};

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
    syncSince: (writer, cursor) =>
      cursor >= 1 ? { changed: [], deleted: [], cursor: 1 } : upsertAll(writer),
    fetchOne: (id) => {
      const found = CORPUS.find((entry) => entry.path === id.path);
      return found === undefined ? undefined : { title: found.title };
    },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    routing: {
      redirects: [
        { from: ${JSON.stringify(MOVED)}, to: ${JSON.stringify(TARGET)}, status: 301 },
      ],
      notFound: [{ locale: "en", path: "/pricing" }],
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

// Checks whether the framework wrote anything, not whether stderr is empty (#184).
async function run(verb: string): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  expect(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  ).toBe("");
}

let routing: RoutingManifest;

beforeAll(async () => {
  writeSite();
  await run("sync");
  await run("build");
  const file = join(OUT, "manifest.json");
  routing = readManifest(readFileSync(file, "utf8"), file).routing;
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

// Asserted first: a compiler handed nothing emits nothing and reports no fault.
test("the build wrote a routing document with the declared rule in it", () => {
  expect(routing.version).toBe(1);
  expect(routing.trees).toHaveLength(1);
  expect(routing.trees[0]?.redirects).toEqual([
    { from: MOVED, to: TARGET, status: 301, source: "config", via: [] },
  ]);
});

test("the vercel compiler turns the built document into a vercel.json row", () => {
  const output = vercel().compile(routing);

  const file = output.artifacts.find((one) => one.path === "/vercel.json");
  const config = JSON.parse(file?.contents ?? "{}") as { redirects?: unknown[] };
  expect(config.redirects).toContainEqual({
    source: MOVED,
    destination: TARGET,
    statusCode: 301,
  });
});

test("the vercel adapter names itself in what it compiles from the built document", () => {
  const output = vercel().compile(routing);

  expect(output.target).toBe("vercel");
  expect(output.artifacts.length).toBeGreaterThan(0);
  expect(output.artifacts.map((one) => one.contents).join("\n")).toContain(MOVED);
});
