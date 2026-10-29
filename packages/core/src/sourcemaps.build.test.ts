import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_CODES } from "./exit.js";
import { RETENTION_DIR, SOURCEMAP_DIR } from "./retention.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const KEPT = join(SITES, ".pagedeck-sourcemaps-test");
const UNKEPT = join(SITES, ".pagedeck-sourcemaps-unkept-test");

// Line 3 throws only when the test asks, so the server render passes.
const COUNTER = `"use client";
export default function Counter() {
  if (globalThis.__pagedeckTraceThrow === true) throw new Error("trace-marker-4d1e");
  return "marker-counter-1f7a";
}
`;

function writeSite(root: string, islandErrors: boolean): void {
  rmSync(root, { recursive: true, force: true });
  const write = (path: string, contents: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write("components/Counter.js", COUNTER);
  write(
    "report.js",
    `export default function report(report) { (globalThis.__islandReports ??= []).push(report); }\n`,
  );
  write("content/en/index.json", `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`);
  write(
    "pagedeck.config.ts",
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: [fromCollection(pages)],
    components: { Counter: "./components/Counter.js" },
    ${islandErrors ? `islandErrors: "./report.js",` : ""}
    tierPolicy: { exclude: ["Counter"] },
    retention: { keep: 2 },
    adapter: {
      name: "stub-edge",
      compile: () => ({
        artifacts: [
          { role: "edge-config", path: "stub.conf", contents: "stub edge config\\n" },
          { role: "tree-file", path: "/_stub", contents: "stub tree file\\n" },
        ],
      }),
    },
    content: () => ({ tree: [{ component: "Counter" }] }),
  },
});
`,
  );
}

afterAll(() => {
  rmSync(KEPT, { recursive: true, force: true });
  rmSync(UNKEPT, { recursive: true, force: true });
});

async function run(cwd: string, ...argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return { out: out.join("\n"), err: err.join("\n") };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort();
}

function tree(dir: string): Record<string, string> {
  return Object.fromEntries(
    filesUnder(dir).map((path) => [path, readFileSync(join(dir, path), "utf8")]),
  );
}

function buildIds(root: string): string[] {
  return readdirSync(join(root, RETENTION_DIR))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function liveId(root: string): string {
  return (
    JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8")) as {
      build: { id: string };
    }
  ).build.id;
}

const ids: string[] = [];

test("a site declaring build.islandErrors writes no map and no sourceMappingURL into its output tree or edge output, and retains a map per chunk under its build id", async () => {
  writeSite(KEPT, true);
  await run(KEPT, "sync");
  await run(KEPT, "build");
  ids.push(liveId(KEPT));

  const published = [join(KEPT, "dist"), join(KEPT, "edge")];
  expect(filesUnder(join(KEPT, "edge"))).toEqual(["stub.conf"]);
  for (const dir of published) {
    for (const path of filesUnder(dir)) {
      expect(path.endsWith(".map"), path).toBe(false);
      expect(readFileSync(join(dir, path), "utf8"), path).not.toContain("sourceMappingURL");
    }
  }

  const maps = filesUnder(join(KEPT, SOURCEMAP_DIR, ids[0] as string));
  const chunks = new Set(filesUnder(join(KEPT, "dist", "assets")).map((name) => `assets/${name}`));
  expect(maps.length).toBeGreaterThan(0);
  for (const map of maps) expect(chunks.has(map.slice(0, -".map".length)), map).toBe(true);
  const counter = maps.find((map) => map.startsWith("assets/Counter-"));
  expect(
    JSON.parse(readFileSync(join(KEPT, SOURCEMAP_DIR, ids[0] as string, counter as string), "utf8")),
  ).toMatchObject({ sources: ["components/Counter.js"], sourcesContent: [COUNTER] });
}, 120_000);

test("two builds of one site retain identical maps", async () => {
  await run(KEPT, "build");
  ids.push(liveId(KEPT));
  const [first, second] = ids as [string, string];

  expect(second).not.toBe(first);
  expect(tree(join(KEPT, SOURCEMAP_DIR, second))).toEqual(
    tree(join(KEPT, SOURCEMAP_DIR, first)),
  );
}, 120_000);

test("an incremental build that reuses the chunks retains their maps under its own id, and pruning past keep removes the oldest build's maps with its manifest", async () => {
  const before = filesUnder(join(KEPT, "dist", "assets"));
  await run(KEPT, "build", "--incremental");
  ids.push(liveId(KEPT));
  const [first, second, third] = ids as [string, string, string];

  expect(filesUnder(join(KEPT, "dist", "assets"))).toEqual(before);
  expect(tree(join(KEPT, SOURCEMAP_DIR, third))).toEqual(
    tree(join(KEPT, SOURCEMAP_DIR, second)),
  );
  expect(buildIds(KEPT)).toEqual([second, third].sort());
  expect(readdirSync(join(KEPT, SOURCEMAP_DIR)).sort()).toEqual([second, third].sort());
  expect(existsSync(join(KEPT, SOURCEMAP_DIR, first))).toBe(false);
}, 120_000);

test("pagedeck trace resolves a thrown island frame to the authored file and line, with and without a build id", async () => {
  const assets = join(KEPT, "dist", "assets");
  const chunk = filesUnder(assets).find((name) => name.startsWith("Counter-")) as string;
  const module = (await import(pathToFileURL(join(assets, chunk)).href)) as Record<string, unknown>;
  const globals = globalThis as { __pagedeckTraceThrow?: boolean };
  globals.__pagedeckTraceThrow = true;
  let stack = "";
  try {
    for (const exported of Object.values(module)) {
      if (typeof exported === "function") (exported as () => unknown)();
    }
  } catch (error) {
    stack = (error as Error).stack ?? "";
  } finally {
    delete globals.__pagedeckTraceThrow;
  }
  const at = new RegExp(`/assets/${chunk.replaceAll(".", "\\.")}:(\\d+):(\\d+)`).exec(stack);
  expect(at, stack).not.toBeNull();
  const frame = `https://example.com/assets/${chunk}:${String(at?.[1])}:${String(at?.[2])}`;

  const newest = await run(KEPT, "trace", frame);
  const named = await run(KEPT, "trace", frame, ids[1] as string);

  expect(newest.out).toMatch(/^components\/Counter\.js:3:\d+$/);
  expect(newest.err).toBe("");
  expect(named.out).toBe(newest.out);
}, 120_000);

test("a site that declares no build.islandErrors writes no sourcemap store", async () => {
  writeSite(UNKEPT, false);
  await run(UNKEPT, "sync");
  await run(UNKEPT, "build");

  expect(existsSync(join(UNKEPT, RETENTION_DIR))).toBe(true);
  expect(existsSync(join(UNKEPT, ".pagedeck", "sourcemaps"))).toBe(false);
}, 120_000);
