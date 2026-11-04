import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineScripts } from "@pagedeck/core";
import type { ScriptDeclaration } from "@pagedeck/core";
import { expect, test } from "vitest";
import { fences } from "./tutorial.test-support.js";

const REFERENCE = join(import.meta.dirname, "..", "reference", "third-party-scripts.md");
const CATALOGUE = join(import.meta.dirname, "..", "..", "..", "docs", "error-messages.md");

function refusal(scripts: readonly ScriptDeclaration[]): string {
  try {
    defineScripts({ scripts });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("defineScripts accepted the declarations");
}

const fenced = (path: string): string[] =>
  fences(readFileSync(path, "utf8")).map(({ code }) => code.trimEnd());

test("the src refusal the page quotes is the one defineScripts throws", () => {
  expect(fenced(REFERENCE)).toContain(
    refusal([{ name: "tags", src: "http://example.com/gtm.js" }]),
  );
});

test("the src refusals the catalogue quotes are the ones defineScripts throws", () => {
  expect(fenced(CATALOGUE)).toContain(
    refusal([
      { name: "a", src: "data:text/javascript,alert(1)" },
      { name: "b", src: "java\tscript:alert(1)" },
      { name: "c", src: "https://user:pw@example.com/a.js" },
    ]),
  );
});
