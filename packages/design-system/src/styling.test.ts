import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { contrastRatio, readThemes } from "@pagedeck/brand";
import { STYLING_OPTIONS } from "./styling.js";

const themes = readThemes(
  readFileSync(join(import.meta.dirname, "..", "..", "brand", "brand.css"), "utf8"),
);

const FILL = /^bg-(?:\((--fw-[\w-]+)\)|(transparent))$/;
const INK = /^text-(?:\((--fw-[\w-]+)\)|(inherit))$/;
const OTHER_COLOUR = /^(?:bg|text|border|outline|ring|decoration)-/;

interface Faults {
  checked: number;
  faults: string[];
}

function colourFaults(): Faults {
  const faults: string[] = [];
  let checked = 0;
  for (const [field, option] of Object.entries(STYLING_OPTIONS)) {
    for (const [value, classes] of Object.entries(option.values)) {
      const names = classes.split(" ");
      const fill = names.map((name) => FILL.exec(name)).find((match) => match !== null);
      const ink = names.map((name) => INK.exec(name)).find((match) => match !== null);
      for (const name of names) {
        if (FILL.test(name) || INK.test(name) || !OTHER_COLOUR.test(name)) continue;
        faults.push(`  ${field} "${value}": ${name} is not a brand token — write it as bg-(--fw-…) or text-(--fw-…)`);
      }
      const fillToken = fill?.[1];
      const inkToken = ink?.[1];
      if (fillToken === undefined && inkToken === undefined) continue;
      if (fillToken === undefined || inkToken === undefined) {
        faults.push(
          `  ${field} "${value}": sets ${fillToken === undefined ? `the ink ${String(inkToken)} and no fill` : `the fill ${fillToken} and no ink`} — set both, so the pair is measured where it is chosen`,
        );
        continue;
      }
      for (const [name, theme] of Object.entries(themes)) {
        checked += 1;
        const ratio = contrastRatio(
          theme.resolved.get(inkToken) as string,
          theme.resolved.get(fillToken) as string,
        );
        if (ratio < 4.5) {
          faults.push(`  ${field} "${value}" (${name}): ${inkToken} on ${fillToken} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }
  return { checked, faults };
}

test("every colour a CMS styling option sets is a brand token pair, AA in both themes", () => {
  const { checked, faults } = colourFaults();
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(checked).toBeGreaterThanOrEqual(8);
});
