import { readFileSync } from "node:fs";
import { openSync } from "fontkit";
import type { Font } from "fontkit";
import subsetFont from "subset-font";
import { ConfigError } from "@pagedeck/core";
import type {
  FontAdapter,
  FontMetrics,
  FontSubsetRequest,
  FontSubsetResult,
} from "@pagedeck/core";
import { isCodepointInRanges, parseUnicodeRange } from "./unicode-range.js";

export function defineFontSubset(): FontAdapter {
  return {
    name: "@pagedeck/font-subset",
    subset(request: FontSubsetRequest): Promise<FontSubsetResult> {
      return subsetFontFace(request);
    },
  };
}

async function subsetFontFace(request: FontSubsetRequest): Promise<FontSubsetResult> {
  const opened = openSync(request.src);
  // `characterSet` is what narrows `Font | FontCollection`; `.type` does not.
  if (!("characterSet" in opened)) {
    throw new ConfigError(
      `Font "${request.family}" ("${request.src}"): is a font collection, not a single face — point "src" at one face's own file, the way FontFace.src already expects`,
    );
  }
  const font: Font = opened;
  const os2 = font["OS/2"];
  if (os2 === undefined) {
    // `fontkit` answers a silent `0` x-height when `OS/2` is missing.
    throw new ConfigError(
      `Font "${request.family}" ("${request.src}"): has no "OS/2" table, so this adapter cannot read its x-height — use a font that carries one`,
    );
  }

  const ranges = request.unicodeRanges.map((range) => parseUnicodeRange(range, request));
  const codepoints = font.characterSet.filter((codepoint) =>
    isCodepointInRanges(codepoint, ranges),
  );
  if (codepoints.length === 0) {
    throw new ConfigError(
      `Font "${request.family}" ("${request.src}"): ${JSON.stringify(request.unicodeRanges)} names no codepoint this font has a glyph for — a subset with nothing to map has no usable "cmap" table, which every browser's font sanitizer refuses outright; declare a range this face actually covers, or point "src" at a face that covers the one declared`,
    );
  }
  const text = codepoints.map((codepoint) => String.fromCodePoint(codepoint)).join("");

  const bytes = await subsetFont(readFileSync(request.src), text, {
    // `subset-font` otherwise echoes the source's format, and a TTF subset is 2.9x
    // the bytes of the WOFF2 one.
    targetFormat: "woff2",
  });

  // One cell is the space glyph's advance: `advanceWidthMax` would be two in a font
  // with double-width CJK glyphs (#534). Glyph 0 is `.notdef`, the answer for no space.
  const space = font.glyphForCodePoint(0x20);
  const monospaceAdvance =
    (postTable(font)?.isFixedPitch ?? 0) !== 0 && space.id !== 0 ? space.advanceWidth : undefined;

  const metrics: FontMetrics = {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    // `hhea.descent` is negative by convention; `FontMetrics.descent` is a magnitude.
    descent: Math.abs(font.descent),
    lineGap: font.lineGap,
    xHeight: font.xHeight,
    ...(monospaceAdvance === undefined ? {} : { monospaceAdvance }),
  };

  return { bytes, metrics };
}

// `@types/fontkit@2.0.9` does not declare `Font.post`, which `fontkit` sets only when
// the font has the table.
function postTable(font: Font): { readonly isFixedPitch: number } | undefined {
  return (font as unknown as { post?: { isFixedPitch: number } }).post;
}
