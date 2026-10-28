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
// Outside every `node_modules`, as a pnpm workspace package's real path is (#138).
const WORKSPACE = join(CORE, "..", ".pagedeck-build-test-package-chunk-names");

const PACKAGES = ["player", "provider-one", "provider-two"] as const;

function write(root: string, file: string, contents: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), contents);
}

function site(): void {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(join(SITE, "node_modules", "@kit"), { recursive: true });
  for (const name of PACKAGES) {
    write(
      WORKSPACE,
      `${name}/package.json`,
      `${JSON.stringify({
        name: `@kit/${name}`,
        type: "module",
        exports: { ".": "./dist/index.js" },
      })}\n`,
    );
    write(
      WORKSPACE,
      `${name}/dist/index.js`,
      `export function label() { return "marker-${name}-8d3e"; }\n`,
    );
    symlinkSync(join(WORKSPACE, name), join(SITE, "node_modules", "@kit", name), "dir");
  }
  write(
    SITE,
    "components/Player.js",
    `"use client";
import { createElement, useEffect, useState } from "react";
import { label } from "@kit/player";

export default function Player() {
  const [text, setText] = useState(label());
  useEffect(() => {
    void Promise.all([import("@kit/provider-one"), import("@kit/provider-two")]).then(
      ([one, two]) => setText(one.label() + " " + two.label()),
    );
  }, []);
  return createElement("output", null, text);
}
`,
  );
  write(SITE, "content/en/home.json", `${JSON.stringify({ rev: 1, data: { title: "home" } })}\n`);
  write(
    SITE,
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

// The page under jsdom, its entry imported as the browser would: the island
// hydrates, and its effect loads both provider chunks.
const HYDRATE = `
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const [html, entry] = process.argv.slice(1);
const { window } = new JSDOM(readFileSync(html, "utf8"));
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "Event", "MutationObserver", "requestIdleCallback", "IntersectionObserver"]) {
  if (key in window) Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true });
}
await import(entry);
const deadline = Date.now() + 10_000;
let text = "";
while (Date.now() < deadline) {
  text = window.document.querySelector("output")?.textContent ?? "";
  if (text.includes("provider-two")) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log(text);
process.exit(0);
`;

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(WORKSPACE, { recursive: true, force: true });
});

test("an island importing packages whose entries are all dist/index.js builds a distinctly named chunk per package, and every chunk loads", async () => {
  site();
  await run("sync");
  await run("build");

  const out = join(SITE, "dist");
  const file = join(out, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const js = manifest.files.filter((entry) => entry.kind === "js").map((entry) => entry.path);
  const imports = new Map(
    js.map((path) => [
      path,
      relativeImports(readFileSync(join(out, path), "utf8")).map((specifier) =>
        posix.join(posix.dirname(path), specifier),
      ),
    ]),
  );
  for (const [path, targets] of imports) {
    for (const target of targets) {
      expect(existsSync(join(out, target)), `${path} imports ${target}`).toBe(true);
    }
  }

  const holding = (name: string) =>
    js.filter((path) => readFileSync(join(out, path), "utf8").includes(`marker-${name}-8d3e`));
  const [player, providerOne, providerTwo] = PACKAGES.map(holding);
  expect(player).toHaveLength(1);
  expect(providerOne).toHaveLength(1);
  expect(providerTwo).toHaveLength(1);
  const providers = [...(providerOne as string[]), ...(providerTwo as string[])];
  expect(new Set(providers.map((path) => posix.basename(path))).size).toBe(2);

  const reached = new Set<string>();
  const queue = [...(player as string[])];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (reached.has(path)) continue;
    reached.add(path);
    queue.push(...(imports.get(path) ?? []));
  }
  for (const path of providers) expect(reached, path).toContain(path);

  const [page] = manifest.pages;
  if (page?.entryChunk === undefined) throw new Error("the page has no entry chunk");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      HYDRATE,
      join(out, page.html),
      pathToFileURL(join(out, page.entryChunk)).href,
    ],
    { cwd: CORE, timeout: 30_000 },
  );
  expect(stdout.trim()).toBe("marker-provider-one-8d3e marker-provider-two-8d3e");
}, 120_000);
