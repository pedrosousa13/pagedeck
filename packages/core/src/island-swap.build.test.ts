// Spawned, not in process: under Vitest every `import()` in this package is Vitest's,
// which compiles JSX itself.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-island-swap");

// Two islands written in JSX with a hook, as a site writes them: each imports
// React's JSX runtime, and the compiler adds its own runtime.
function island(name: string, marker: string): string {
  return `"use client";
import { useState } from "react";

export default function ${name}() {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen(!open)}>
      ${marker} {String(open)}
    </button>
  );
}
`;
}

const CONFIG = `
import { defineConfig, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages)],
    components: {
      Faq: "./components/Faq.tsx",
      Signup: "./components/Signup.tsx",
    },
    content: (page, store) => ({
      tree: store
        .getEntry("pages", page.entry.locale, page.entry.path)
        .data.islands.map((component) => ({ component })),
    }),
  },
});
`;

function write(file: string, contents: string): void {
  mkdirSync(dirname(join(SITE, file)), { recursive: true });
  writeFileSync(join(SITE, file), contents);
}

function page(rev: number, islands: readonly string[]): string {
  return `${JSON.stringify({ rev, data: { islands } })}\n`;
}

async function pagedeck(...argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...argv], { cwd: SITE });
  return stdout;
}

function html(path: string): string {
  return readFileSync(join(SITE, "site", path, "index.html"), "utf8");
}

function scripts(document: string): string[] {
  return [...document.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1] as string);
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("a page that swaps its island for another page's builds incrementally, and the other page is reused byte for byte", async () => {
  rmSync(SITE, { recursive: true, force: true });
  write("components/Faq.tsx", island("Faq", "marker-faq-61c4"));
  write("components/Signup.tsx", island("Signup", "marker-signup-8d2a"));
  write("content/en/faq.json", page(1, ["Faq"]));
  write("content/en/signup.json", page(1, ["Signup"]));
  write("pagedeck.config.ts", CONFIG);
  await pagedeck("sync");
  await pagedeck("build");
  const signup = html("signup");

  write("content/en/faq.json", page(2, ["Signup"]));
  await pagedeck("sync", "--incremental");
  const built = await pagedeck("build", "--incremental");

  expect(built).toContain("incremental: 1 of 2 pages rendered, 1 reused, 0 removed");
  expect(html("signup")).toBe(signup);
  const faq = html("faq");
  expect(faq).toMatch(/<fw-island\b[^>]*data-fw-component="Signup"/);
  expect(faq).not.toContain('data-fw-component="Faq"');
  expect(scripts(faq)).toEqual(scripts(signup));
}, 180_000);
