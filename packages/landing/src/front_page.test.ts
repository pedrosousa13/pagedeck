import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const PACKAGE = join(import.meta.dirname, "..");
const INDEX = readFileSync(join(PACKAGE, "content", "index.md"), "utf8");

const SAMPLES = [...INDEX.matchAll(/^### (.+)\n+```tsx\n([\s\S]*?)\n```$/gm)].map(
  (match) => ({ heading: (match[1] as string).replace(/`/g, ""), code: match[2] as string }),
);

test("the code section shows two samples, a server component and the island it renders", () => {
  expect(SAMPLES.map((sample) => sample.heading)).toEqual([
    "server_data_page.tsx",
    "variant_picker.tsx",
  ]);
  expect(SAMPLES[0]?.code).not.toContain('"use client"');
  expect(SAMPLES[1]?.code.split("\n")[0]).toBe('"use client";');
});

test("every line of each sample is a line of the file its heading names", () => {
  for (const { heading, code } of SAMPLES) {
    const file = join(PACKAGE, "src", "components", heading);
    expect(existsSync(file), file).toBe(true);
    const source = new Set(readFileSync(file, "utf8").split("\n").map((line) => line.trim()));
    const unsourced = code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//") && !source.has(line));
    expect(unsourced, heading).toEqual([]);
  }
});
