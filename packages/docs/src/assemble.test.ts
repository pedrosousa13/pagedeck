import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const SCRIPT = join(import.meta.dirname, "assemble.ts");

let root = "";

afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

async function assemble(): Promise<void> {
  await execFileAsync(process.execPath, [SCRIPT], { cwd: join(root, "packages", "docs") });
}

test("copies each page nav.json lists from the repository's docs, and leaves the package's own pages", async () => {
  root = mkdtempSync(join(tmpdir(), "pagedeck-docs-assemble-"));
  write(
    "packages/docs/nav.json",
    JSON.stringify([
      { label: "Guides", pages: ["index.md"] },
      { label: "Explanation", pages: ["adr/0001-a.md", "deploy-recipe.md"] },
    ]),
  );
  write("packages/docs/index.md", "own");
  write("docs/adr/0001-a.md", "adr");
  write("docs/deploy-recipe.md", "recipe");
  write("docs/specs/unlisted.md", "unlisted");

  await assemble();

  expect(readFileSync(join(root, "packages/docs/adr/0001-a.md"), "utf8")).toBe("adr");
  expect(readFileSync(join(root, "packages/docs/deploy-recipe.md"), "utf8")).toBe("recipe");
  expect(readFileSync(join(root, "packages/docs/index.md"), "utf8")).toBe("own");
  expect(existsSync(join(root, "packages/docs/specs"))).toBe(false);
}, 30_000);

test("removes a copy nav.json no longer lists from a directory it copies into", async () => {
  root = mkdtempSync(join(tmpdir(), "pagedeck-docs-assemble-"));
  write("packages/docs/nav.json", JSON.stringify([{ label: "Explanation", pages: ["adr/0002-b.md"] }]));
  write("packages/docs/adr/0001-a.md", "stale");
  write("docs/adr/0002-b.md", "b");

  await assemble();

  expect(existsSync(join(root, "packages/docs/adr/0001-a.md"))).toBe(false);
  expect(readFileSync(join(root, "packages/docs/adr/0002-b.md"), "utf8")).toBe("b");
}, 30_000);
