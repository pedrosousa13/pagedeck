// Spawned, not in process: under Vitest every `import()` in this package is Vitest's,
// which compiles JSX itself.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-island-swap-shared");

// As in `island-swap.build.test.ts`, and each island also imports a module the
// site wrote, which Rolldown splits by its own rules when no tier group claims
// it (#720).
function island(name: string, marker: string, helper = "caption"): string {
  return `"use client";
import { useState } from "react";
import { ${helper} as caption } from "./shared.ts";

export default function ${name}() {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen(!open)}>
      {caption("${marker}", open)}
    </button>
  );
}
`;
}

const SHARED = `export function caption(marker: string, open: boolean): string {
  return \`\${marker} \${open ? "open" : "shut"}\`;
}
`;

// Each island takes its own export, so the one that leaves takes its export's
// last importer with it.
const SHARED_APART = `${SHARED}export function label(marker: string, open: boolean): string {
  return \`[\${marker}] \${open ? "yes" : "no"}\`;
}
`;

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
  return [...document.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1] ?? "");
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("a page that swaps its island for another page's, when both islands import a site module, builds incrementally, and the other page is reused byte for byte", async () => {
  rmSync(SITE, { recursive: true, force: true });
  write("components/Faq.tsx", island("Faq", "marker-faq-61c4"));
  write("components/Signup.tsx", island("Signup", "marker-signup-8d2a"));
  write("components/shared.ts", SHARED);
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

function assets(document: string): string[] {
  return [...document.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

function withoutAssets(document: string): string {
  return document.replace(/\/assets\/[^"]+/g, "");
}

function emitted(path: string): boolean {
  return existsSync(join(SITE, "site", path));
}

test("a reused page whose chunks moved because the island that left took a shared export's last importer is rendered again, naming only chunks this build emitted", async () => {
  rmSync(SITE, { recursive: true, force: true });
  write("components/Faq.tsx", island("Faq", "marker-faq-61c4"));
  write("components/Signup.tsx", island("Signup", "marker-signup-8d2a", "label"));
  write("components/shared.ts", SHARED_APART);
  write("content/en/faq.json", page(1, ["Faq"]));
  write("content/en/signup.json", page(1, ["Signup"]));
  write("pagedeck.config.ts", CONFIG);
  await pagedeck("sync");
  await pagedeck("build");
  const signup = html("signup");

  write("content/en/faq.json", page(2, ["Signup"]));
  await pagedeck("sync", "--incremental");
  const built = await pagedeck("build", "--incremental");

  expect(built).toContain("incremental: 2 of 2 pages rendered, 0 reused, 0 removed");
  const after = html("signup");
  expect(assets(after)).not.toEqual(assets(signup));
  expect(withoutAssets(after)).toBe(withoutAssets(signup));
  for (const document of [after, html("faq")]) {
    expect(assets(document).length).toBeGreaterThan(0);
    for (const asset of assets(document)) expect(emitted(asset), asset).toBe(true);
  }
  expect(scripts(html("faq"))).toEqual(scripts(after));
}, 180_000);

test("a reused page whose chunk gains an export for an island another page adds is rendered again, naming only chunks this build emitted", async () => {
  rmSync(SITE, { recursive: true, force: true });
  write("components/Faq.tsx", island("Faq", "marker-faq-61c4"));
  write("components/Signup.tsx", island("Signup", "marker-signup-8d2a"));
  write("components/shared.ts", SHARED);
  write("content/en/faq.json", page(1, ["Signup"]));
  write("content/en/signup.json", page(1, ["Signup"]));
  write("pagedeck.config.ts", CONFIG);
  await pagedeck("sync");
  await pagedeck("build");
  const signup = html("signup");

  write("content/en/faq.json", page(2, ["Faq"]));
  await pagedeck("sync", "--incremental");
  const built = await pagedeck("build", "--incremental");

  expect(built).toContain("incremental: 2 of 2 pages rendered, 0 reused, 0 removed");
  const after = html("signup");
  expect(withoutAssets(after)).toBe(withoutAssets(signup));
  const faq = html("faq");
  expect(faq).toMatch(/<fw-island\b[^>]*data-fw-component="Faq"/);
  for (const document of [after, faq]) {
    expect(assets(document).length).toBeGreaterThan(0);
    for (const asset of assets(document)) expect(emitted(asset), asset).toBe(true);
  }
}, 180_000);

