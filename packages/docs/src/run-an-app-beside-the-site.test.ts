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
