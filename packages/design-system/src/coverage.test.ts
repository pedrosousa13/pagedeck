import { expect, test } from "vitest";
import { componentNames } from "@pagedeck/site/loader";
import { DRAFT_ENTRIES, PUBLISHED_ENTRIES } from "@pagedeck/site/content";
import { components } from "./index.js";
import { getComponent } from "@pagedeck/islands";
import type { PageEntry } from "@pagedeck/site/content";

function usage(
  sets: readonly (readonly PageEntry[])[],
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const set of sets) {
    for (const entry of set) {
      for (const name of componentNames(entry.data)) {
        const at = found.get(name) ?? [];
        at.push(`/${entry.locale}/${entry.path}`);
        found.set(name, at);
      }
    }
  }
  return found;
}

const USAGE = usage([PUBLISHED_ENTRIES, DRAFT_ENTRIES]);

test("the entries name components at all", () => {
  expect(USAGE.size).toBeGreaterThan(0);
});

test("every component the content names is registered", () => {
  const missing: string[] = [];
  for (const [name, at] of [...USAGE].sort()) {
    if (getComponent(components, name) === undefined) {
      missing.push(`  ${name} — ${[...new Set(at)].sort().join(", ")}`);
    }
  }
  expect(missing.length === 0 ? "" : `\n${missing.join("\n")}`).toBe("");
});
