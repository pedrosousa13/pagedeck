import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// By position, one entry per fence. `null` is a fence that quotes no file in this repository:
// an example a site might write, or a message the build prints.
const FONTS_SAMPLES: readonly (readonly string[] | null)[] = [null, null, ["packages/site/src/site.ts"]];

function unsourcedSampleLines(name: string, samples: readonly (readonly string[] | null)[]): string[] {
  const repo = join(import.meta.dirname, "..", "..", "..");
  const page = join(import.meta.dirname, "..", "reference", name);
  expect(existsSync(page), page).toBe(true);
  const fences = [...readFileSync(page, "utf8").matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] as string,
  );
  expect(fences).toHaveLength(samples.length);

  const missing: string[] = [];
  fences.forEach((fence, index) => {
    const files = samples[index];
    if (files === null || files === undefined) return;
    const lines = new Set(
      files.flatMap((file) =>
        readFileSync(join(repo, file), "utf8")
          .split("\n")
          .map((line) => line.trim()),
      ),
    );
    for (const line of fence.split("\n").map((text) => text.trim())) {
      if (line === "" || line.startsWith("//")) continue;
      if (!lines.has(line)) missing.push(`sample ${String(index + 1)}: ${line}`);
    }
  });
  return missing;
}

test("every code sample on the fonts page is a line of a site that builds with it", () => {
  expect(unsourcedSampleLines("fonts.md", FONTS_SAMPLES)).toEqual([]);
});
