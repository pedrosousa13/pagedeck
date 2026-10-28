import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const execFileAsync = promisify(execFile);

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const SITE = join(SITES, ".pagedeck-package-chunk-names-test");

const PACKAGES = ["player", "provider-one", "provider-two"] as const;

function write(file: string, contents: string): void {
  mkdirSync(dirname(join(SITE, file)), { recursive: true });
  writeFileSync(join(SITE, file), contents);
}

// The layout pnpm gives workspace packages: each entry at `dist/index.js`,
// linked into `node_modules` (#138).
function site(): void {
  rmSync(SITE, { recursive: true, force: true });
  for (const name of PACKAGES) {
    write(
      `packages/${name}/package.json`,
      `${JSON.stringify({
        name: `@kit/${name}`,
        type: "module",
        exports: { ".": "./dist/index.js" },
      })}\n`,
    );
    write(
      `packages/${name}/dist/index.js`,
      `export function label() { return "marker-${name}-8d3e"; }\n`,
    );
    mkdirSync(join(SITE, "node_modules", "@kit"), { recursive: true });
    symlinkSync(
      `../../packages/${name}`,
      join(SITE, "node_modules", "@kit", name),
      "dir",
    );
  }
  write(
    "components/Player.js",
    `"use client";
import { createElement, useEffect, useState } from "react";
import { label } from "@kit/player";

export const providers = () =>
  Promise.all([import("@kit/provider-one"), import("@kit/provider-two")]);

export default function Player() {
  const [text, setText] = useState(label());
  useEffect(() => {
    void providers().then(([one, two]) => setText(one.label() + two.label()));
  }, []);
  return createElement("output", null, text);
}
`,
  );
  write("content/en/home.json", `${JSON.stringify({ rev: 1, data: { title: "home" } })}\n`);
  write(
    "pagedeck.config.ts",
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

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
    pages: [fromCollection(pages, { route: () => "/" })],
    components: { Player: { path: "./components/Player.js", hydrate: "load" } },
    content: () => ({ tree: [{ component: "Player" }] }),
  },
});
`,
  );
}

async function run(...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: SITE,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

function relativeImports(source: string): string[] {
  return [
    ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'`](\.{1,2}\/[^"'`]+)["'`]/g),
  ].map((match) => match[1] as string);
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("an island importing packages whose entries are all dist/index.js builds a distinctly named chunk per package, and every chunk loads", async () => {
  site();
  await run("sync");
  await run("build");

  const out = join(SITE, "dist");
  const file = join(out, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const js = manifest.files.filter((one) => one.kind === "js");
  for (const one of js) {
    for (const specifier of relativeImports(readFileSync(join(out, one.path), "utf8"))) {
      expect(
        existsSync(join(out, posix.join(posix.dirname(one.path), specifier))),
        `${one.path} imports ${specifier}`,
      ).toBe(true);
    }
  }

  const holding = (name: string) =>
    js
      .filter((one) => readFileSync(join(out, one.path), "utf8").includes(`marker-${name}-8d3e`))
      .map((one) => one.path);
  const [player, one, two] = PACKAGES.map(holding);
  expect(player).toHaveLength(1);
  expect(one).toHaveLength(1);
  expect(two).toHaveLength(1);
  const providers = [...(one ?? []), ...(two ?? [])];
  expect(new Set(providers.map((path) => posix.basename(path))).size).toBe(2);
  const island = relativeImports(readFileSync(join(out, player?.[0] ?? ""), "utf8"));
  for (const path of providers) expect(island).toContain(`./${posix.basename(path)}`);

  // A page entry starts the islands runtime against `document`, which Node lacks.
  const entries = new Set(manifest.pages.map((page) => page.entryChunk));
  const loadable = js.map((chunk) => chunk.path).filter((path) => !entries.has(path));
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `for (const path of ${JSON.stringify(loadable)}) {
  const chunk = await import(new URL("." + path, ${JSON.stringify(pathToFileURL(out + "/").href)}));
  if (typeof chunk.label === "function") console.log(chunk.label());
}`,
    ],
    { cwd: SITE },
  );
  expect(stdout.trim().split("\n").sort()).toEqual([
    "marker-provider-one-8d3e",
    "marker-provider-two-8d3e",
  ]);
}, 120_000);
