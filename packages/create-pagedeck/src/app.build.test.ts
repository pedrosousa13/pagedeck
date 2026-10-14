import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { create } from "./index.js";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "..", "core", "dist", "bin.js");
const TSC = join(PACKAGE, "..", "..", "node_modules", "typescript", "bin", "tsc");
// Inside the package, so the site resolves `@pagedeck/*`, React and Hono from its node_modules (#77).
const ROOT = mkdtempSync(join(PACKAGE, ".pagedeck-app-build-test-"));

const TYPE_IMPORT = 'import type { AppType } from "../app/index.ts";';

interface Manifest {
  pages: { path: string }[];
  routing: { trees: { upstreams?: { prefix: string; url?: string }[] }[] };
}

async function written(name: string): Promise<string> {
  await create([name, "--app"], ROOT, { stdin: new PassThrough(), stdout: new PassThrough() });
  return join(ROOT, name);
}

let site = "";

beforeAll(async () => {
  site = await written("app-site");
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: site });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: site });
}, 180_000);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function assets(): { file: string; code: string }[] {
  const dir = join(site, "site", "assets");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ file, code: readFileSync(join(dir, file), "utf8") }));
}

test("the --app site builds /hello and declares /api/ as an upstream with no url", () => {
  const manifest = JSON.parse(readFileSync(join(site, "site", "manifest.json"), "utf8")) as Manifest;
  expect(manifest.pages.map((page) => page.path)).toContain("/hello/");
  expect(manifest.routing.trees.map((tree) => tree.upstreams)).toEqual([[{ prefix: "/api/" }]]);
});

test("the island's chunk calls the app through hc and carries none of the app's code", () => {
  const hello = assets().filter(({ file }) => file.startsWith("hello-"));
  expect(hello.map(({ code }) => code.includes("$get"))).toEqual([true]);
  const app = readFileSync(join(site, "app", "index.ts"), "utf8");
  const unique = ["The app answered.", "no-store"];
  for (const marker of unique) expect(app).toContain(marker);
  expect(
    assets().flatMap(({ file, code }) => unique.filter((marker) => code.includes(marker)).map((marker) => `${file}: ${marker}`)),
  ).toEqual([]);
});

test("the --app site typechecks, so hc<AppType> checks the island's call against the app", async () => {
  await expect(execFileAsync(process.execPath, [TSC, "-p", site])).resolves.toBeDefined();
}, 120_000);

test("an island that imports a value from app/ fails the build with the upstream-source refusal", async () => {
  const broken = await written("value-import-site");
  const island = join(broken, "components", "hello.tsx");
  const source = readFileSync(island, "utf8");
  expect(source).toContain(TYPE_IMPORT);
  writeFileSync(
    island,
    source.replace(TYPE_IMPORT, `${TYPE_IMPORT}\nimport app from "../app/index.ts";\nconsole.log(app);`),
  );
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: broken });

  const failed = await execFileAsync(process.execPath, [BIN, "build"], { cwd: broken }).then(
    () => {
      throw new Error("pagedeck build succeeded with an island importing the app's code");
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toContain(
    "import from island code reaches the source of an upstream app, so the app's code would ship to the browser",
  );
  expect(failed.stderr).toContain(
    `imports "../app/index.ts" — build.routing.upstreams[0] source "app/"`,
  );
}, 180_000);
