// Two site directories, not one rewritten: Node's ESM cache is keyed by URL, so a
// rewritten config would build under the one first imported.
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

const WHOLE = join(import.meta.dirname, "..", ".pagedeck-build-test-paged-lists");
const BEYOND = join(import.meta.dirname, "..", ".pagedeck-build-test-paged-lists-off");

const OFF_THE_END = "/posts/page/9";

const LIST = `import { createElement } from "react";
export default function List({ titles, links }) {
  return createElement(
    "section",
    null,
    "marker-list-3f7a " + titles.join(" "),
    links.map((href) => createElement("a", { key: href, href }, href)),
  );
}
`;

const ENTRIES = ["a", "b", "c", "d", "e"];

function site(root: string, extra: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "List.js"), LIST);

  for (const path of ENTRIES) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ rev: 1, data: { title: path } })}\n`,
    );
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, paginate } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const posts = {
  name: "posts",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [posts],
  build: {
    outDir: "./dist",
    origin: "https://example.com",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        paginate({
          pageSize: 2,
          lists: (store) => [
            { locale: "en", path: ["posts"], entries: store.listEntries("posts") },
          ],
        }),
      ],
    }),
    components: { List: "./components/List.js" },
    content: (page, store) => {
      const titles = page.dependencies.map(
        (ref) => store.getEntry("posts", ref.locale, ref.path).data.title,
      );
      const links = [page.paging.prev, page.paging.next${extra}].filter(
        (href) => href !== undefined,
      );
      return { tree: [{ component: "List", props: { titles, links } }] };
    },
  },
});
`,
  );
  return root;
}

interface Run {
  code: number;
  err: string;
}

async function pagedeck(cwd: string, verb: string): Promise<Run> {
  try {
    const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: EXIT_CODES.success, err: stderr };
  } catch (thrown) {
    const failure = thrown as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, err: failure.stderr ?? "" };
  }
}

async function build(root: string): Promise<Run> {
  const synced = await pagedeck(root, "sync");
  if (synced.code !== EXIT_CODES.success) throw new Error(synced.err);
  return pagedeck(root, "build");
}

afterAll(() => {
  for (const root of [WHOLE, BEYOND]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a list's paged addresses are pages the link checker resolves", async () => {
  const result = await build(site(WHOLE, ""));

  expect(result.code).toBe(EXIT_CODES.success);

  const document = (path: string): string =>
    join(WHOLE, "dist", path, "index.html");
  expect(existsSync(document("posts"))).toBe(true);
  expect(existsSync(document(join("posts", "page", "2")))).toBe(true);
  expect(existsSync(document(join("posts", "page", "3")))).toBe(true);
  expect(existsSync(document(join("posts", "page", "1")))).toBe(false);

  const manifest = readManifest(
    readFileSync(join(WHOLE, "dist", MANIFEST_FILE), "utf8"),
    join(WHOLE, "dist", MANIFEST_FILE),
  );
  expect(manifest.pages.map((page) => page.path)).toEqual([
    "/posts",
    "/posts/page/2",
    "/posts/page/3",
  ]);

  const first = readFileSync(document("posts"), "utf8");
  expect(first).toContain('href="/posts/page/2"');
  expect(first).not.toContain('href="/posts/page/1"');
  expect(first).toContain("marker-list-3f7a a b");

  const second = readFileSync(document(join("posts", "page", "2")), "utf8");
  expect(second).toContain('href="/posts"');
  expect(second).toContain('href="/posts/page/3"');
  expect(second).toContain("marker-list-3f7a c d");

  expect(second).toContain(
    '<link rel="canonical" href="https://example.com/posts/page/2">',
  );
  expect(first).toContain(
    '<link rel="canonical" href="https://example.com/posts">',
  );
}, 120_000);

test("an address past the end of a list is a broken link like any other", async () => {
  const result = await build(site(BEYOND, `, "${OFF_THE_END}"`));

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "Site build: 3 references name nothing this build emitted",
  );
  expect(result.err).toMatch(/^pagedeck: {3}en \/posts — "\/posts\/page\/9"$/m);
  expect(existsSync(join(BEYOND, "dist"))).toBe(false);
}, 120_000);
