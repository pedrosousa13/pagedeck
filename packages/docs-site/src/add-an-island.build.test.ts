import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { fences, STARTER_TEMPLATE } from "./tutorial.test-support.js";

const execFileAsync = promisify(execFile);

const HOW_TO = join(import.meta.dirname, "..", "..", "docs", "how-to", "add-an-island.md");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");
// Inside the package, so the site resolves `@pagedeck/*` and React from its node_modules.
const SITE = mkdtempSync(join(import.meta.dirname, "..", ".pagedeck-how-to-island-test-"));

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

interface Row {
  locale: string;
  path: string;
  limit: number;
  actual: number;
  html: number;
  chunks: { path: string; bytes: number }[];
}

// Chunk hashes and byte figures move with React, the runtime and the bundler;
// every word, page, pattern, limit and chunk name must still match.
const unhashed = (text: string): string => text.replace(/-[\w-]{8}\.js/g, "-<hash>.js");

const normalisedOutput = (text: string): string =>
  unhashed(text).replace(/(transfers |— )\d+ B/g, "$1<n> B");

const normalisedRow = (row: Row): Row => ({
  ...row,
  actual: 0,
  html: 0,
  chunks: row.chunks.map(({ path }) => ({ path: unhashed(path), bytes: 0 })),
});

interface Run {
  code: number;
  output: string;
}

async function pagedeck(verb: string): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, output: failed.stdout + failed.stderr };
  }
}

// A fence naming `pagedeck.config.ts` that is not the whole file is one key of `build`.
function spliceBuildKey(config: string, snippet: string): string {
  const lines = config.split("\n");
  const added = snippet.trimEnd().split("\n").map((line) => `    ${line}`);
  const key = /^(\w+):/.exec(snippet)?.[1];
  expect(key, `a config fence that is not the whole file starts with a key of build:\n${snippet}`).toBeDefined();
  const start = lines.findIndex((line) => line.startsWith(`    ${key as string}:`));
  if (start === -1) {
    const end = lines.indexOf("  },");
    lines.splice(end, 0, ...added);
    return lines.join("\n");
  }
  let depth = 0;
  let end = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end] as string;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) break;
  }
  lines.splice(start, end - start + 1, ...added);
  return lines.join("\n");
}

function scripts(route: string): number {
  const file = join(SITE, "site", route === "/" ? "" : route, "index.html");
  return [...readFileSync(file, "utf8").matchAll(/<script\b/g)].length;
}

test("the island how-to, followed fence by fence from the starter, builds, fails and reports as the page says", async () => {
  expect(existsSync(HOW_TO), HOW_TO).toBe(true);
  cpSync(STARTER_TEMPLATE, SITE, { recursive: true });

  const page = fences(readFileSync(HOW_TO, "utf8"));
  let build: Run | undefined;
  let builds = 0;
  let quotedFailures = 0;
  let quotedRows = 0;
  const settle = (): void => {
    if (build !== undefined) expect(build.code, build.output).toBe(0);
    build = undefined;
  };

  for (const { lang, code, file } of page) {
    if (lang === "sh") {
      settle();
      for (const line of code.trim().split("\n")) {
        const verb = /^npx pagedeck (sync|build)$/.exec(line)?.[1];
        expect(verb, `a shell line this test knows how to run: ${line}`).toBeDefined();
        const run = await pagedeck(verb as string);
        if (verb === "sync") {
          expect(run.code, run.output).toBe(0);
          continue;
        }
        builds += 1;
        build = run;
        if (builds === 1) {
          expect(run.code, run.output).toBe(0);
          expect([scripts("/"), scripts("/about"), scripts("/greet")]).toEqual([0, 0, 1]);
        }
      }
    } else if (file === "pagedeck.config.ts" && !code.startsWith("import ")) {
      const path = join(SITE, file);
      writeFileSync(path, spliceBuildKey(readFileSync(path, "utf8"), code));
    } else if (file !== undefined) {
      mkdirSync(dirname(join(SITE, file)), { recursive: true });
      writeFileSync(join(SITE, file), code);
    } else if (lang === "") {
      expect(build, `a build ran before the output this fence quotes:\n${code}`).toBeDefined();
      expect((build as Run).code, (build as Run).output).toBe(2);
      expect(normalisedOutput((build as Run).output)).toContain(normalisedOutput(code));
      build = undefined;
      quotedFailures += 1;
    } else if (lang === "json") {
      settle();
      const row = JSON.parse(code) as Row;
      const report = JSON.parse(
        readFileSync(join(SITE, ".pagedeck", "budget-report.json"), "utf8"),
      ) as { pages: Row[] };
      const real = report.pages.find(
        ({ locale, path }) => locale === row.locale && path === row.path,
      );
      expect(real && normalisedRow(real)).toEqual(normalisedRow(row));
      // The page's prose quotes this figure, so it must not drift far from the build's.
      expect(Math.abs((real as Row).actual - row.actual) / row.actual).toBeLessThanOrEqual(0.05);
      for (const island of report.pages.filter(({ chunks }) => chunks.length > 0)) {
        expect(island.actual, `${island.path} under the limit the page gives it`).toBeLessThanOrEqual(
          island.limit,
        );
      }
      quotedRows += 1;
    } else {
      throw new Error(`a fence this test cannot check, in ${lang}:\n${code}`);
    }
  }
  settle();

  expect({ quotedFailures, quotedRows }).toEqual({ quotedFailures: 1, quotedRows: 1 });
}, 180_000);
