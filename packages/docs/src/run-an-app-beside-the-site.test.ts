import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fences, quotes } from "./tutorial.test-support.js";

const HOW_TO = join(import.meta.dirname, "..", "how-to", "run-an-app-beside-the-site.md");

const EXAMPLE = join(import.meta.dirname, "..", "..", "app-example");

test("every code sample names the example file it quotes, and is a run of that file's lines", () => {
  expect(existsSync(HOW_TO), HOW_TO).toBe(true);
  const samples = fences(readFileSync(HOW_TO, "utf8"));
  expect(samples.length).toBeGreaterThan(0);
  for (const { code, file } of samples) {
    expect(file, `a fence whose lead names the example file it quotes:\n${code}`).toBeDefined();
    const path = join(EXAMPLE, file as string);
    expect(existsSync(path), `${file}, in packages/app-example`).toBe(true);
    expect(quotes(readFileSync(path, "utf8"), code), `${file} holds these lines, in order:\n${code}`).toBe(
      true,
    );
  }
});

test("the live checklist names each check a local run cannot make", () => {
  const page = readFileSync(HOW_TO, "utf8");
  const start = page.indexOf("### The live checklist");
  expect(start, "a section headed The live checklist").toBeGreaterThan(-1);
  const checklist = page.slice(start, page.indexOf("\n## ", start));
  const checks = [...checklist.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((match) => match[1]);
  expect(checks).toEqual([
    "Access on the preview host.",
    "`workers.dev` off.",
    "Preview URLs off.",
    "Direct origin refused.",
  ]);
});
