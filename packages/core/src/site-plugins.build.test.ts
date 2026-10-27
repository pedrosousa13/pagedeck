// Spawned, not in process: under Vitest every `import()` in this package is Vitest's,
// which compiles JSX itself.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-site-plugins");

const COUNTER = `"use client";
import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState<number>(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      marker-aliased-5e2d {count}
    </button>
  );
}
`;

// `@/` is an alias only the site's plugin knows.
const CONFIG = `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

const alias = {
  name: "site:alias",
  resolveId(source: string) {
    return source.startsWith("@/")
      ? ${JSON.stringify(`${SITE}/`)} + source.slice(2)
      : undefined;
  },
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
    components: { Counter: "@/components/Counter.tsx" },
    vite: { plugins: [alias] },
    content: () => ({ tree: [{ component: "Counter" }] }),
  },
});
`;

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("a component module behind a site plugin's alias is scanned, built and islanded", async () => {
  rmSync(SITE, { recursive: true, force: true });
  const files: Record<string, string> = {
    "components/Counter.tsx": COUNTER,
    "content/en/home.json": `${JSON.stringify({ rev: 1, data: {} })}\n`,
    "pagedeck.config.ts": CONFIG,
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(SITE, file)), { recursive: true });
    writeFileSync(join(SITE, file), source);
  }

  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });

  const html = readFileSync(join(SITE, "dist", "index.html"), "utf8");
  const islands = [...html.matchAll(/<fw-island\b[^>]*>/g)].map(
    (match) => match[0],
  );
  expect(islands).toHaveLength(1);
  expect(islands[0]).toContain('data-fw-component="Counter"');
  expect(html).toContain("marker-aliased-5e2d");
}, 120_000);
