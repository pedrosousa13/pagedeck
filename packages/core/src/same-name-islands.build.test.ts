// Spawned, not in process: under Vitest every `import()` in this package is Vitest's,
// which compiles JSX itself.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-same-name-islands");

// Each island is below the tier policy's `minSize`, so no tier group takes it,
// and both in a directory import its `ease.ts`, so Rolldown splits it (#68).
function island(name: string, marker: string): string {
  return `"use client";
import { useState } from "react";
import { ease } from "./ease.ts";

export default function ${name}() {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen(!open)}>
      {ease("${marker}", open)}
    </button>
  );
}
`;
}

function ease(marker: string): string {
  return `export function ease(label: string, open: boolean): string {
  return \`\${label} ${marker} \${open ? "in" : "out"}\`;
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
      FadeA: "./components/a/fade.tsx",
      CurveA: "./components/a/curve.tsx",
      FadeB: "./components/b/fade.tsx",
      CurveB: "./components/b/curve.tsx",
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

function page(rev: number, title: string, islands: readonly string[]): string {
  return `${JSON.stringify({ rev, data: { title, islands } })}\n`;
}

async function pagedeck(...argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...argv], { cwd: SITE });
  return stdout;
}

interface Chunks {
  fade: string[];
  ease: string[];
}

interface Manifest {
  files: readonly { path: string; kind: string; chunk?: { name: string } }[];
  tiers: { assignments: readonly { component: string; group?: string }[] };
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(SITE, "site", "manifest.json"), "utf8")) as Manifest;
}

function chunks(): Chunks {
  const js = manifest().files.filter((file) => file.kind === "js");
  return {
    fade: js
      .filter((file) => /\/fade-[^/]+\.js$/.test(file.path))
      .map((file) => file.path)
      .sort(),
    ease: js
      .filter((file) => file.chunk?.name === "ease")
      .map((file) => file.path)
      .sort(),
  };
}

function markers(paths: readonly string[], pattern: RegExp): (string | undefined)[] {
  return paths
    .map((path) => pattern.exec(readFileSync(join(SITE, "site", path), "utf8"))?.[0])
    .sort();
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("islands and split chunks that share a file name build into a chunk each, and an incremental build keeps every address", async () => {
  rmSync(SITE, { recursive: true, force: true });
  write("components/a/fade.tsx", island("FadeA", "marker-fade-a-4c91"));
  write("components/a/curve.tsx", island("CurveA", "marker-curve-a-2b58"));
  write("components/a/ease.ts", ease("marker-ease-a-90d6"));
  write("components/b/fade.tsx", island("FadeB", "marker-fade-b-7e03"));
  write("components/b/curve.tsx", island("CurveB", "marker-curve-b-1f4a"));
  write("components/b/ease.ts", ease("marker-ease-b-5c27"));
  write("content/en/one.json", page(1, "One", ["FadeA", "CurveA"]));
  write("content/en/two.json", page(1, "Two", ["FadeB", "CurveB"]));
  write("pagedeck.config.ts", CONFIG);
  await pagedeck("sync");
  await pagedeck("build");
  const { files, tiers } = manifest();
  expect(tiers.assignments.filter((one) => one.group !== undefined)).toEqual([]);
  for (const file of files.filter((one) => one.path.startsWith("/assets/fw-"))) {
    expect(readFileSync(join(SITE, "site", file.path), "utf8"), file.path).not.toMatch(
      /marker-(?:fade|curve|ease)-[ab]-/,
    );
  }
  const full = chunks();
  expect(markers(full.fade, /marker-fade-[ab]-\w+/)).toEqual([
    "marker-fade-a-4c91",
    "marker-fade-b-7e03",
  ]);
  expect(markers(full.ease, /marker-ease-[ab]-\w+/)).toEqual([
    "marker-ease-a-90d6",
    "marker-ease-b-5c27",
  ]);

  write("content/en/one.json", page(2, "One, edited", ["FadeA", "CurveA"]));
  await pagedeck("sync", "--incremental");
  const built = await pagedeck("build", "--incremental");

  expect(built).toContain("incremental: 1 of 2 pages rendered, 1 reused, 0 removed");
  expect(chunks()).toEqual(full);
}, 180_000);
