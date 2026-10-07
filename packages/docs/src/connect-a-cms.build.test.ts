import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EXAMPLE, HOW_TO, REPORT } from "./connect-a-cms.test-support.js";
import { fences } from "./tutorial.test-support.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// Inside the example, so the copied config resolves `@pagedeck/cms-example` and React from
// its package; a copy of its own, so the example's `site.build.test.ts` can run beside it.
const SITE = mkdtempSync(join(EXAMPLE, ".pagedeck-how-to-cms-test-"));

interface Row {
  path: string;
  actual: number;
  chunks: { path: string; bytes: number }[];
}

// Chunk hashes and byte figures move with React, the runtime and the bundler; every page,
// limit and chunk name must still match.
const unhashed = (text: string): string => text.replace(/-[\w-]{8}\.js/g, "-<hash>.js");

// Only the fields the page quotes, since it trims each row.
function normalised(row: Row, fields: readonly string[]): Record<string, unknown> {
  const kept = Object.fromEntries(fields.map((field) => [field, row[field as keyof Row]]));
  return {
    ...kept,
    ...("actual" in kept ? { actual: row.actual === 0 ? 0 : "<n>" } : {}),
    ...("chunks" in kept
      ? { chunks: row.chunks.map(({ path }) => ({ path: unhashed(path), bytes: "<n>" })) }
      : {}),
  };
}

let cms: ChildProcess | undefined;
let rows: Row[] = [];

beforeAll(async () => {
  cpSync(join(EXAMPLE, "pagedeck.config.ts"), join(SITE, "pagedeck.config.ts"));
  cpSync(join(EXAMPLE, "src", "components"), join(SITE, "src", "components"), { recursive: true });
  const serving = spawn(process.execPath, [join(EXAMPLE, "dist", "serve.js"), "0"]);
  cms = serving;
  const url = await new Promise<string>((resolve, reject) => {
    serving.once("error", reject);
    serving.once("exit", (code) => reject(new Error(`the CMS exited with ${String(code)}`)));
    serving.stdout.on("data", (chunk: Buffer) => {
      const found = /CMS serving at (\S+)/.exec(chunk.toString());
      if (found !== null) resolve(found[1] as string);
    });
  });
  const env = { ...process.env, PAGEDECK_CMS_EXAMPLE_URL: url };
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE, env });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE, env });
  rows = (JSON.parse(readFileSync(join(SITE, REPORT), "utf8")) as { pages: Row[] }).pages;
}, 180_000);

afterAll(() => {
  cms?.kill();
  rmSync(SITE, { recursive: true, force: true });
});

test("the budget report rows the page quotes are the rows the example's build writes", () => {
  expect(existsSync(HOW_TO), HOW_TO).toBe(true);
  const quoted = fences(readFileSync(HOW_TO, "utf8")).filter(({ file }) => file === REPORT);
  expect(quoted).toHaveLength(1);
  const quotedRows = JSON.parse(quoted[0]?.code ?? "") as Row[];
  expect(quotedRows.map(({ path }) => path)).toEqual(rows.map(({ path }) => path));

  for (const row of quotedRows) {
    const real = rows.find(({ path }) => path === row.path) as Row;
    const fields = Object.keys(row);
    expect(normalised(real, fields), row.path).toEqual(normalised(row, fields));
    // The page's prose reads these figures, so they must not drift far from the build's.
    expect(Math.abs(real.actual - row.actual), row.path).toBeLessThanOrEqual(row.actual * 0.05);
  }
}, 180_000);
