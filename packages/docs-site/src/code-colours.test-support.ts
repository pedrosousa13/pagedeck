// Read whole, then parsed, so a colour that cannot be measured is refused:
// matching six hex digits would read `#24292e77` as opaque.
export interface CodeColours {
  readonly light: Set<string>;
  readonly dark: Set<string>;
  readonly unmeasurable: string[];
}

function opaqueHex(value: string): string | undefined {
  const hex = /^#([0-9a-f]+)$/i.exec(value)?.[1]?.toLowerCase();
  if (hex === undefined) return undefined;
  if (hex.length === 3) return `#${hex.replace(/(.)/g, "$1$1")}`;
  if (hex.length === 6) return `#${hex}`;
  if (hex.length === 4 && hex.endsWith("f")) return opaqueHex(`#${hex.slice(0, 3)}`);
  if (hex.length === 8 && hex.endsWith("ff")) return `#${hex.slice(0, 6)}`;
  return undefined;
}

export function codeColours(html: string): CodeColours {
  const found: CodeColours = { light: new Set(), dark: new Set(), unmeasurable: [] };
  for (const [, style] of html.matchAll(
    /<(?:span|pre)\b[^>]*\sstyle="([^"]*--shiki-dark:[^"]*)"/g,
  )) {
    for (const [property, into] of [
      ["color", found.light],
      ["--shiki-dark", found.dark],
    ] as const) {
      const value = new RegExp(`(?:^|;)${property}:([^;]*)`).exec(style as string)?.[1]?.trim();
      const colour = value === undefined ? undefined : opaqueHex(value);
      if (colour === undefined) found.unmeasurable.push(`${property}:${value ?? "(absent)"}`);
      else into.add(colour);
    }
  }
  return found;
}
