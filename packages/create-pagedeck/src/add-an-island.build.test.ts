import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { fences, STARTER_TEMPLATE } from "../../docs/src/tutorial.test-support.js";

const execFileAsync = promisify(execFile);

const HOW_TO = join(import.meta.dirname, "..", "..", "docs", "how-to", "add-an-island.md");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");
// Inside the package, so the site resolves `@pagedeck/*` and React from its node_modules.
const SITE = mkdtempSync(join(import.meta.dirname, "..", ".pagedeck-how-to-island-test-"));

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
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

test("the island how-to, followed fence by fence from the starter, builds as the page says", async () => {
  expect(existsSync(HOW_TO), HOW_TO).toBe(true);
  cpSync(STARTER_TEMPLATE, SITE, { recursive: true });

  const page = fences(readFileSync(HOW_TO, "utf8"));
  let builds = 0;

  for (const { lang, code, file } of page) {
    if (lang === "sh") {
      for (const line of code.trim().split("\n")) {
        const verb = /^npx pagedeck (sync|build)$/.exec(line)?.[1];
        expect(verb, `a shell line this test knows how to run: ${line}`).toBeDefined();
        const run = await pagedeck(verb as string);
        expect(run.code, run.output).toBe(0);
        if (verb === "build") {
          builds += 1;
          expect([scripts("/"), scripts("/about"), scripts("/greet")]).toEqual([0, 0, 1]);
        }
      }
    } else if (file === "pagedeck.config.ts" && !code.startsWith("import ")) {
      const path = join(SITE, file);
      writeFileSync(path, spliceBuildKey(readFileSync(path, "utf8"), code));
    } else if (file !== undefined) {
      mkdirSync(dirname(join(SITE, file)), { recursive: true });
      writeFileSync(join(SITE, file), code);
    } else {
      throw new Error(`a fence this test cannot check, in ${lang}:\n${code}`);
    }
  }

  expect(builds).toBe(1);
}, 180_000);
