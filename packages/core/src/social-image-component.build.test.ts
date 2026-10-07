// Spawned: an in-process build under Vitest runs a second copy of `tree.tsx`, whose
// context a natively loaded component cannot reach.
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const TREES_SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-own-card");
const INCREMENTAL_SITE = join(
  import.meta.dirname,
  "..",
  ".pagedeck-build-test-own-card-incremental",
);

const CARD = `import { createElement } from "react";
import { useSocialCard } from "@pagedeck/core/tree";
export default function Card() {
  const card = useSocialCard();
  return card === undefined
    ? createElement("p", null, "no-card-7c1d")
    : createElement("img", { src: card.href, width: card.width, height: card.height, alt: "card-7c1d" });
}
`;

const ADAPTER = `{
      name: "stub-cards",
      draw: (request) => ({
        bytes: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ...new TextEncoder().encode(request.page.locale + request.page.path + ";" + String(request.title)),
        ]),
        width: 1200,
        height: 630,
      }),
    }`;

function site(
  root: string,
  locales: string,
  contentLocales: readonly string[],
  carded: readonly string[],
): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Card.js"), CARD);
  for (const locale of contentLocales) {
    for (const [path, title] of [
      ["home", "Home"],
      ["about", "About"],
    ]) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
    }
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

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
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        ${locales}
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: { Card: "./components/Card.js" },
    head: (page, store) => ({
      title: store.getEntry("pages", page.locale, page.entry.path).data.title,
    }),
    socialImages: {
      adapter: ${ADAPTER},
      inputs: (page) => (${JSON.stringify(carded)}.includes(page.path) ? {} : undefined),
    },
    content: () => ({ tree: [{ component: "Card" }] }),
  },
});
`,
  );
  return root;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function pagedeck(cwd: string, ...argv: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [BIN, ...argv],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return { code: EXIT_CODES.success, out: stdout, err: stderr };
  } catch (thrown) {
    const failure = thrown as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? -1,
      out: failure.stdout ?? "",
      err: failure.stderr ?? "",
    };
  }
}

async function ok(cwd: string, ...argv: string[]): Promise<Run> {
  const result = await pagedeck(cwd, ...argv);
  if (result.code !== EXIT_CODES.success) throw new Error(result.err);
  return result;
}

function ownCardSrc(document: string): string | undefined {
  return /<img src="([^"]*)"[^>]*alt="card-7c1d"/.exec(document)?.[1];
}

afterAll(() => {
  for (const root of [TREES_SITE, INCREMENTAL_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a component renders its own page's card URL, and every output tree holds the card at it", async () => {
  const dir = site(
    TREES_SITE,
    `en: { label: "en", direction: "ltr", domain: "example.com" },
        de: { label: "de", direction: "ltr", domain: "example.de" },`,
    ["en", "de"],
    ["/"],
  );
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, MANIFEST_FILE);
  const rows = readManifest(readFileSync(file, "utf8"), file).files;

  for (const tree of ["example.com", "example.de"]) {
    const document = readFileSync(join(dist, tree, "index.html"), "utf8");
    const src = ownCardSrc(document);
    expect(src).toMatch(/^\/social\/[a-z-]+\.[0-9a-f]{8}\.png$/);
    expect(document).toContain(
      `<meta property="og:image" content="${String(src)}">`,
    );
    expect(document).toContain(
      `src="${String(src)}" width="1200" height="630"`,
    );
    expect(
      rows.filter((row) => row.path === src).map((row) => row.domain),
    ).toEqual(["example.com", "example.de"]);
    expect(existsSync(join(dist, tree, String(src).slice(1)))).toBe(true);
  }
  const about = readFileSync(
    join(dist, "example.com", "about", "index.html"),
    "utf8",
  );
  expect(ownCardSrc(about)).toBeUndefined();
  expect(about).toContain("no-card-7c1d");
}, 240_000);

test("a re-rendered page's component shows the card this run drew, and a reused page keeps the one it named", async () => {
  const dir = site(
    INCREMENTAL_SITE,
    `en: { label: "en", direction: "ltr" },`,
    ["en"],
    ["/", "/about"],
  );
  await ok(dir, "sync");
  await ok(dir, "build");
  const dist = join(dir, "dist");
  const homeBefore = readFileSync(join(dist, "index.html"), "utf8");
  const aboutBefore = ownCardSrc(
    readFileSync(join(dist, "about", "index.html"), "utf8"),
  );
  expect(aboutBefore).toMatch(/^\/social\/en-about\.[0-9a-f]{8}\.png$/);

  writeFileSync(
    join(dir, "content", "en", "about.json"),
    `${JSON.stringify({ rev: 2, data: { title: "Edited" } })}\n`,
  );
  await ok(dir, "sync");
  const { out } = await ok(dir, "build", "--incremental");
  expect(out).toContain("incremental: 1 of 2 pages rendered, 1 reused");

  const home = readFileSync(join(dist, "index.html"), "utf8");
  expect(home).toBe(homeBefore);
  const homeSrc = ownCardSrc(home);
  expect(homeSrc).toMatch(/^\/social\/en\.[0-9a-f]{8}\.png$/);
  expect(existsSync(join(dist, String(homeSrc).slice(1)))).toBe(true);

  const about = ownCardSrc(
    readFileSync(join(dist, "about", "index.html"), "utf8"),
  );
  expect(about).toMatch(/^\/social\/en-about\.[0-9a-f]{8}\.png$/);
  expect(about).not.toBe(aboutBefore);
  const file = join(dist, MANIFEST_FILE);
  const cards = readManifest(readFileSync(file, "utf8"), file)
    .files.filter((row) => row.path.startsWith("/social/"))
    .map((row) => row.path)
    .sort();
  expect(cards).toEqual([homeSrc, about].sort());
  expect(existsSync(join(dist, String(about).slice(1)))).toBe(true);
  expect(existsSync(join(dist, String(aboutBefore).slice(1)))).toBe(false);
}, 240_000);
