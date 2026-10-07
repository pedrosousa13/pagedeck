import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { RETENTION_DIR } from "./retention.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-rollback");
const OUT = join(SITE, "dist");
// Beside the site, not inside it: inside, `pagedeck build` would walk it and a rollback would
// restore a copy of itself.
const SAVED = join(import.meta.dirname, "..", ".pagedeck-build-test-rollback-tree");

const hero = (marker: string): string =>
  `export default function Hero() { return ${JSON.stringify(marker)}; }\n`;

// `rev` rises with each edit: `createFixtureLoader` reads it as the cursor, so an
// unchanged `rev` syncs nothing.
function writeEntry(rev: number, title: string): void {
  const file = join(SITE, "content", "en", "home.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ rev, data: { title } })}\n`);
}

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(SAVED, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });
  writeFileSync(join(SITE, "components", "Hero.js"), hero("marker-hero-one"));
  writeEntry(1, "Home");

  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: (page, store) => ({
      tree: [
        {
          component: "Hero",
          props: { title: store.getEntry("pages", "en", "home").data.title },
        },
      ],
    }),
  },
});
`,
  );
}

async function run(...argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...argv], {
    cwd: SITE,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function emitted(): Manifest {
  const file = join(OUT, MANIFEST_FILE);
  return readManifest(readFileSync(file, "utf8"), file);
}

function digests(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name))
      .split(sep)
      .join("/");
    if (path === MANIFEST_FILE) continue;
    files.set(
      path,
      `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`,
    );
  }
  return files;
}

interface DiffDocument {
  trees: readonly {
    domain?: string;
    upload: readonly {
      path: string;
      hash: string;
      kind: string;
      change: string;
    }[];
    prune: readonly { path: string; hash: string }[];
  }[];
}

// Reads the document and nothing else, so it follows the plan rather than re-deriving it.
// Prunes at once, ignoring `notBefore`: no page here is stale.
function applyRollback(document: DiffDocument, source: string): void {
  for (const tree of document.trees) {
    const root = join(OUT, tree.domain ?? "");
    for (const file of tree.upload) {
      const from = join(source, tree.domain ?? "", file.path);
      const bytes = readFileSync(from);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        file.hash,
      );
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    for (const file of tree.prune) unlinkSync(join(root, file.path));
  }
}

interface Rolled {
  first: Manifest;
  second: Manifest;
  document: DiffDocument;
  raw: string;
}

const rolled = buildTwiceAndRollBack();

async function buildTwiceAndRollBack(): Promise<Rolled> {
  writeSite();
  await run("sync");
  await run("build");
  const first = emitted();
  cpSync(OUT, SAVED, { recursive: true });

  writeEntry(2, "Home v2");
  writeFileSync(join(SITE, "components", "Hero.js"), hero("marker-hero-two"));
  await run("sync");
  await run("build");
  const second = emitted();

  const raw = await run("rollback", first.build.id);
  return { first, second, document: JSON.parse(raw) as DiffDocument, raw };
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(SAVED, { recursive: true, force: true });
});

test("the second build records the first as its parent, and the store holds both", async () => {
  const { first, second } = await rolled;

  expect(second.build.parent).toBe(first.build.id);
  expect(second.build.id).not.toBe(first.build.id);
  expect(readdirSync(join(SITE, RETENTION_DIR)).sort()).toEqual(
    [`${first.build.id}.json`, `${second.build.id}.json`].sort(),
  );
}, 180_000);

test("the rollback document uploads the older build's assets and prunes the newer build's", async () => {
  const { document } = await rolled;
  const [tree] = document.trees;

  expect(document.trees).toHaveLength(1);
  const uploads = tree?.upload ?? [];
  const prunes = tree?.prune ?? [];
  expect(uploads.map((file) => file.path)).toContain("/index.html");
  expect(uploads.some((file) => file.kind === "js" && file.change === "added")).toBe(
    true,
  );
  const html = uploads.findIndex((file) => file.kind === "html");
  expect(html).toBeGreaterThan(0);
  expect(uploads.slice(html).every((file) => file.kind === "html")).toBe(true);
  expect(prunes.length).toBeGreaterThan(0);
}, 180_000);

test("applying the rollback document to the live tree reproduces the retained build's tree exactly", async () => {
  const { document } = await rolled;

  expect([...digests(OUT).entries()].sort()).not.toEqual(
    [...digests(SAVED).entries()].sort(),
  );

  applyRollback(document, SAVED);

  expect([...digests(OUT).entries()].sort()).toEqual(
    [...digests(SAVED).entries()].sort(),
  );
}, 180_000);

test("pagedeck diff --force over the same two documents writes the same plan", async () => {
  const { first, raw } = await rolled;

  const diffed = await run(
    "diff",
    join("dist", MANIFEST_FILE),
    join(RETENTION_DIR, `${first.build.id}.json`),
    "--force",
  );

  expect(diffed).toContain(`  "forced": true,\n`);
  expect(raw).not.toContain("forced");
  expect(
    diffed
      .split("\n")
      .filter((line) => line !== `  "forced": true,`)
      .join("\n"),
  ).toBe(raw);
}, 180_000);

test("pagedeck diff refuses the rollback direction without --force", async () => {
  const { first, second } = await rolled;

  const failure = await run(
    "diff",
    join("dist", MANIFEST_FILE),
    join(RETENTION_DIR, `${first.build.id}.json`),
  ).then(
    () => {
      throw new Error("pagedeck diff deployed a build that predates the live one");
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failure.code).toBe(2);
  expect(failure.stderr).toContain(first.build.id);
  expect(failure.stderr).toContain(second.build.id);
  expect(failure.stderr).toContain("--force");
}, 180_000);
