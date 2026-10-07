import { contrastRatio } from "./contrast.js";

export interface Theme {
  declared: Map<string, string>;
  resolved: Map<string, string>;
}

export interface ContrastPair {
  fg: string;
  bg: string;
  ratio: number;
  minimum: 4.5 | 3;
}

export const DECORATION: readonly string[] = ["--fw-rule"];

export const NON_COLOUR: readonly RegExp[] = [
  /^--fw-font-/,
  /^--fw-text-/,
  /^--fw-leading-/,
  /^--fw-space-/,
  /^--fw-radius-/,
  /^--fw-ring-(width|offset)$/,
];

const COLOUR_VALUE = /^(#|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\()/i;

const DARK_QUERY = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g;

export function readThemes(css: string): { light: Theme; dark: Theme } {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const darkSpans = [...source.matchAll(DARK_QUERY)].map((match) => {
    const start = match.index + match[0].length;
    return { start, end: closingBrace(source, start) };
  });
  const inDark = (at: number): boolean =>
    darkSpans.some(({ start, end }) => at >= start && at < end);

  const blocks = [...source.matchAll(/:root\s*\{([^}]*)\}/g)];
  const lights = blocks.filter((block) => !inDark(block.index));
  const darks = blocks.filter((block) => inDark(block.index));
  for (const [which, found] of [["light", lights], ["dark", darks]] as const) {
    if (found.length > 1) {
      throw new Error(
        `Brand tokens: found ${String(found.length)} ${which} :root blocks — declare the ${which} theme in one, so the one this check reads is the one a browser applies`,
      );
    }
  }
  const [light] = lights;
  const [dark] = darks;
  if (light === undefined) {
    throw new Error(
      "Brand tokens: found no top-level :root — declare the light theme's tokens in one",
    );
  }
  if (dark === undefined) {
    throw new Error(
      "Brand tokens: found no :root inside @media (prefers-color-scheme: dark) — declare the dark theme there, beside the light :root",
    );
  }
  const lightDeclared = declarations(light[1] as string);
  const darkDeclared = declarations(dark[1] as string);
  return {
    light: theme(lightDeclared, lightDeclared),
    dark: theme(darkDeclared, new Map([...lightDeclared, ...darkDeclared])),
  };
}

export function contrastPairs(theme: Theme): ContrastPair[] {
  const names = [...theme.resolved.keys()];
  const onInks = names.filter((name) => name.startsWith("--fw-fg-on-"));
  const fills = new Set(onInks.map((ink) => ink.replace("--fw-fg-on-", "--fw-bg-")));
  const texts = names.filter(
    (name) => /^--fw-fg(-|$)/.test(name) && !onInks.includes(name),
  );
  const surfaces = names.filter(
    (name) => /^--fw-bg(-|$)/.test(name) && !fills.has(name),
  );

  const pair = (fg: string, bg: string, minimum: 4.5 | 3): ContrastPair => ({
    fg,
    bg,
    minimum,
    ratio: contrastRatio(
      theme.resolved.get(fg) as string,
      theme.resolved.get(bg) as string,
    ),
  });
  return [
    ...texts.flatMap((fg) => surfaces.map((bg) => pair(fg, bg, 4.5))),
    ...onInks.map((ink) => pair(ink, ink.replace("--fw-fg-on-", "--fw-bg-"), 4.5)),
    ...(theme.resolved.has("--fw-ring")
      ? surfaces.map((bg) => pair("--fw-ring", bg, 3))
      : []),
  ];
}

export function unclassifiedTokens(theme: Theme): string[] {
  return [...theme.resolved].flatMap(([name, value]) => {
    if (/^--fw-(fg|bg)(-|$)/.test(name) || name === "--fw-ring") return [];
    if (DECORATION.includes(name)) return [];
    if (NON_COLOUR.some((family) => family.test(name)) && !COLOUR_VALUE.test(value)) {
      return [];
    }
    return [name];
  });
}

function theme(declared: Map<string, string>, inEffect: Map<string, string>): Theme {
  const resolved = new Map<string, string>();
  for (const name of inEffect.keys()) {
    resolved.set(name, resolve(name, inEffect, []));
  }
  return { declared, resolved };
}

function resolve(name: string, inEffect: Map<string, string>, seen: string[]): string {
  const value = inEffect.get(name);
  if (value === undefined || seen.includes(name)) {
    throw new Error(
      `Brand tokens: ${[...seen, name].join(" → ")} does not resolve to a value — declare ${name} in the light :root`,
    );
  }
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  return reference === null
    ? value
    : resolve(reference[1] as string, inEffect, [...seen, name]);
}

function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--fw-[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name as string, (value as string).trim());
  }
  return found;
}

function closingBrace(source: string, from: number): number {
  let depth = 1;
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") depth -= 1;
    if (depth === 0) return at;
  }
  return source.length;
}
