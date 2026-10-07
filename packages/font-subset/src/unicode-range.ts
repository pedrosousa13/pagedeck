import { ConfigError } from "@pagedeck/core";

export interface CodepointRange {
  readonly start: number;
  readonly end: number;
}

export interface DeclaringFace {
  readonly family: string;
  readonly src: string;
}

const UNICODE_RANGE = /^U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/i;

export function parseUnicodeRange(range: string, face: DeclaringFace): CodepointRange {
  const match = UNICODE_RANGE.exec(range);
  const first = match?.[1];
  if (match === null || first === undefined) {
    // Unreachable after core's validation; kept so a bad match throws rather than
    // producing a wrong subset.
    throw new ConfigError(
      `Font ${JSON.stringify(face.family)} (${JSON.stringify(face.src)}): ${JSON.stringify(range)} is not a value "unicodeRanges" takes — write each range as U+<hex>, U+<hex>-<hex>, or U+<hex>? with trailing "?" wildcards, such as "U+0000-00FF"`,
    );
  }
  const second = match[2];
  if (second !== undefined) {
    return { start: Number.parseInt(first, 16), end: Number.parseInt(second, 16) };
  }
  if (first.includes("?")) {
    const wildcardCount = first.split("").filter((ch) => ch === "?").length;
    const literalPrefix = first.slice(0, first.length - wildcardCount);
    const span = 16 ** wildcardCount;
    const start = Number.parseInt(literalPrefix.padEnd(first.length, "0"), 16);
    return { start, end: start + span - 1 };
  }
  const codepoint = Number.parseInt(first, 16);
  return { start: codepoint, end: codepoint };
}

export function isCodepointInRanges(
  codepoint: number,
  ranges: readonly CodepointRange[],
): boolean {
  return ranges.some((range) => codepoint >= range.start && codepoint <= range.end);
}
