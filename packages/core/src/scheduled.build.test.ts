// The dates are centuries away because `now` is the real build stamp: a fixture dated
// next week would fail in a fortnight.
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

const DIR = join(import.meta.dirname, "..", ".pagedeck-build-test-scheduled");

const NAV = `import { createElement } from "react";
export default function Nav({ title }) {
  return createElement("nav", null, "marker-nav-9c22 " + title);
}
`;

const ENTRIES = {
  evergreen: { title: "Evergreen" },
  open: {
    title: "Open",
    publish_at: "2000-01-01T00:00:00Z",
    unpublish_at: "2999-01-01T00:00:00Z",
  },
  future: { title: "Future", publish_at: "2999-01-01T00:00:00Z" },
  expired: { title: "Expired", unpublish_at: "2000-01-01T00:00:00Z" },
};

function site(): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "components"), { recursive: true });
  writeFileSync(join(DIR, "components", "Nav.js"), NAV);

  for (const [path, data] of Object.entries(ENTRIES)) {
    const file = join(DIR, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
  }

  writeFileSync(
    join(DIR, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const posts = {
  name: "posts",
  loader: createFixtureLoader(${JSON.stringify(join(DIR, "content"))}),
  schema: false,
  publishField: "publish_at",
  unpublishField: "unpublish_at",
};

export default defineConfig({
  store: "./content.db",
  collections: [posts],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(posts, { route: (entry) => "/" + entry.path })],
    }),
    components: { Nav: "./components/Nav.js" },
    content: (page, store) => {
      const entry = store.getEntry("posts", page.locale, page.entry.path);
      return {
        tree: [{ component: "Nav", props: { title: entry.data.title } }],
      };
    },
  },
});
`,
  );
}

interface Run {
  code: number;
  err: string;
}

async function pagedeck(verb: string): Promise<Run> {
  try {
    const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
      cwd: DIR,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: EXIT_CODES.success, err: stderr };
  } catch (thrown) {
    const failure = thrown as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, err: failure.stderr ?? "" };
  }
}

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

test("a build emits the entries inside their publication window and no others", async () => {
  site();
  const synced = await pagedeck("sync");
  if (synced.code !== EXIT_CODES.success) throw new Error(synced.err);

  const built = await pagedeck("build");

  expect(built.code).toBe(EXIT_CODES.success);
  const document = (path: string): string =>
    join(DIR, "dist", path, "index.html");
  expect(existsSync(document("evergreen"))).toBe(true);
  expect(existsSync(document("open"))).toBe(true);
  expect(existsSync(document("future"))).toBe(false);
  expect(existsSync(document("expired"))).toBe(false);

  const manifest = readManifest(
    readFileSync(join(DIR, "dist", MANIFEST_FILE), "utf8"),
    join(DIR, "dist", MANIFEST_FILE),
  );
  expect(manifest.pages.map((page) => page.path)).toEqual([
    "/evergreen",
    "/open",
  ]);
}, 120_000);
