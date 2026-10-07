import { contrastRatio } from "./contrast.js";
import type { Theme } from "./tokens.js";

const COLOUR_PROPERTY =
  /(?:^|[{;\s])((?:background-color|background|color|border(?:-[a-z]+)*-color|border(?:-(?:top|right|bottom|left))?|outline(?:-color)?|text-decoration(?:-color)?|fill|stroke|caret-color|accent-color|box-shadow))\s*:\s*([^;}]+)/g;

// `#0000` is `transparent` as the toolkit's minifier spells it.
const ALLOWED =
  /^(?:var\(--fw-[\w-]+\)|var\(--shiki-dark(?:-bg)?\)|#0000|inherit|currentcolor|transparent|none|0|initial|unset)$/i;

const NOT_A_COLOUR =
  /^(?:[\d.]+(?:px|rem|em)?|solid|dashed|dotted|underline|var\(--fw-(?:ring-width|ring-offset|radius-[a-z]+|space-[\w-]+)\))$/;

function uncommented(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function colourFaults(css: string): { checked: number; faults: string[] } {
  const faults: string[] = [];
  let checked = 0;
  for (const [, property, raw] of uncommented(css).matchAll(COLOUR_PROPERTY)) {
    const value = (raw as string).replace(/\s*!important$/, "").trim();
    const parts = value
      .split(/\s+(?![^(]*\))/)
      .filter((part) => !NOT_A_COLOUR.test(part));
    for (const part of parts) {
      checked += 1;
      if (!ALLOWED.test(part)) faults.push(`  ${property as string}: ${value}`);
    }
  }
  return { checked, faults };
}

export function pairFaults(
  css: string,
  themes: { readonly light: Theme; readonly dark: Theme },
): { measured: string[]; faults: string[] } {
  const token = (body: string, property: string): string | undefined =>
    new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*var\\((--fw-[\\w-]+)\\)`).exec(body)?.[1];

  const faults: string[] = [];
  const measured: string[] = [];
  for (const [, rawSelector, body] of uncommented(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const fg = token(body as string, "color");
    const bg = token(body as string, "background-color");
    if (fg === undefined || bg === undefined) continue;
    const selector = (rawSelector as string).trim();
    measured.push(selector);
    for (const [name, theme] of Object.entries(themes)) {
      const ratio = contrastRatio(
        theme.resolved.get(fg) as string,
        theme.resolved.get(bg) as string,
      );
      if (ratio < 4.5) {
        faults.push(`  ${selector} (${name}): ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  return { measured, faults };
}
