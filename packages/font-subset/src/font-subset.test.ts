import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fontkit from "fontkit";
import { ConfigError } from "@pagedeck/core";
import type { FontAdapter, FontSubsetRequest } from "@pagedeck/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildFontFixture } from "./font-fixture.test-support.js";
import { defineFontSubset } from "./font-subset.js";

let dir: string;
let srcPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "font-subset-test-"));
  srcPath = join(dir, "source.ttf");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSourceFixture(): void {
  writeFileSync(
    srcPath,
    buildFontFixture({ codepoints: [0x41, 0x42, 0x43, 0x44, 0x45] }),
  );
}

function request(overrides: Partial<FontSubsetRequest> = {}): FontSubsetRequest {
  return {
    family: "Acme Sans",
    src: srcPath,
    unicodeRanges: ["U+41-42"],
    ...overrides,
  };
}

// `@types/fontkit@2.0.9` does not declare `Font.directory`, which exists at runtime.
function tableTags(font: fontkit.Font): string[] {
  const withDirectory = font as unknown as { directory: { tables: Record<string, unknown> } };
  return Object.keys(withDirectory.directory.tables).sort();
}

test("the adapter satisfies core's FontAdapter type", () => {
  // Compile-time assertion: `tsc` fails this, not `expect`.
  const adapter: FontAdapter = defineFontSubset();
  expect(adapter.name).toBe("@pagedeck/font-subset");
});

test("subsetting to a narrower range yields a smaller file than the input", async () => {
  writeSourceFixture();
  const inputSize = buildFontFixture({ codepoints: [0x41, 0x42, 0x43, 0x44, 0x45] }).length;
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+41-42"] }));
  expect(result.bytes.length).toBeLessThan(inputSize);
});

test("the returned metrics match the source font's own tables, not the subset's", async () => {
  writeFileSync(
    srcPath,
    buildFontFixture({
      codepoints: [0x41],
      unitsPerEm: 2000,
      ascent: 1600,
      descent: -400,
      lineGap: 100,
      xHeight: 1000,
    }),
  );
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+41"] }));
  expect(result.metrics).toEqual({
    unitsPerEm: 2000,
    ascent: 1600,
    descent: 400,
    lineGap: 100,
    xHeight: 1000,
  });
});

test("a fixed-pitch font's metrics carry its space glyph's advance, read off the post table's isFixedPitch", async () => {
  writeFileSync(srcPath, buildFontFixture({ codepoints: [0x20, 0x41], isFixedPitch: true }));
  const fixed = await defineFontSubset().subset(request({ unicodeRanges: ["U+20-41"] }));
  expect(fixed.metrics.monospaceAdvance).toBe(700);

  writeFileSync(srcPath, buildFontFixture({ codepoints: [0x20, 0x41] }));
  const proportional = await defineFontSubset().subset(request({ unicodeRanges: ["U+20-41"] }));
  expect("monospaceAdvance" in proportional.metrics).toBe(false);
});

test("a font with no post table is read as proportional rather than refused", async () => {
  writeFileSync(srcPath, buildFontFixture({ codepoints: [0x20, 0x41], isFixedPitch: true, omitPost: true }));
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+20-41"] }));
  expect("monospaceAdvance" in result.metrics).toBe(false);
});

test("a fixed-pitch font with no space glyph carries no advance rather than .notdef's", async () => {
  writeFileSync(srcPath, buildFontFixture({ codepoints: [0x41], isFixedPitch: true }));
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+41"] }));
  expect("monospaceAdvance" in result.metrics).toBe(false);
});

test("subsetting the same font against the same ranges twice produces byte-identical output", async () => {
  writeSourceFixture();
  const adapter = defineFontSubset();
  const first = await adapter.subset(request());
  const second = await adapter.subset(request());
  expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
});

test("the subset's own cmap covers exactly the declared range's intersection with the font, and no others", async () => {
  writeSourceFixture();
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+41-42"] }));
  const reopened = fontkit.create(Buffer.from(result.bytes)) as fontkit.Font;
  expect(reopened.characterSet.sort((a, b) => a - b)).toEqual([0x41, 0x42]);
  expect(reopened.hasGlyphForCodePoint(0x43)).toBe(false);
});

test("a declared range wider than the font's own coverage subsets to just the overlap", async () => {
  writeSourceFixture();
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+0-10FFFF"] }));
  const reopened = fontkit.create(Buffer.from(result.bytes)) as fontkit.Font;
  expect(reopened.characterSet.sort((a, b) => a - b)).toEqual([0x41, 0x42, 0x43, 0x44, 0x45]);
});

test("the subset is a structurally complete sfnt — every table OTS requires is present", async () => {
  writeSourceFixture();
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+41-42"] }));
  const reopened = fontkit.create(Buffer.from(result.bytes)) as fontkit.Font;
  expect(tableTags(reopened)).toEqual(
    ["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"].sort(),
  );
});

test("a single-codepoint range subsets to one mapped character", async () => {
  writeSourceFixture();
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+43"] }));
  const reopened = fontkit.create(Buffer.from(result.bytes)) as fontkit.Font;
  expect(reopened.characterSet).toEqual([0x43]);
});

test("a range the source font has no glyphs in is refused rather than subset to an unusable font", async () => {
  writeSourceFixture();
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+390-3FF"] })),
  ).rejects.toThrow(/no codepoint this font has a glyph for/);
});

test("a range naming no codepoint the font covers is a wiring fault, not a crash", async () => {
  writeSourceFixture();
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+390-3FF"] })),
  ).rejects.toThrow(ConfigError);
});

test("a wildcard range intersects the same way a pair does", async () => {
  writeSourceFixture();
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+4?"] }));
  const reopened = fontkit.create(Buffer.from(result.bytes)) as fontkit.Font;
  expect(reopened.characterSet.sort((a, b) => a - b)).toEqual([0x41, 0x42, 0x43, 0x44, 0x45]);
});

test("a face declaring no OS/2 table is refused rather than answered with a silent zero x-height", async () => {
  const fixture = buildFontFixture({ codepoints: [0x41] });
  const numTables = new DataView(fixture.buffer).getUint16(4, false);
  let stripped: Uint8Array | null = null;
  for (let i = 0; i < numTables; i++) {
    const recordOffset = 12 + i * 16;
    const tag = Buffer.from(fixture.subarray(recordOffset, recordOffset + 4)).toString("ascii");
    if (tag === "OS/2") {
      // Renaming the tag hides the table from `fontkit` without moving any offset.
      stripped = new Uint8Array(fixture);
      stripped.set(Buffer.from("ZZZZ", "ascii"), recordOffset);
    }
  }
  if (stripped === null) throw new Error("fixture has no OS/2 table to strip");
  writeFileSync(srcPath, stripped);
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+41"] })),
  ).rejects.toThrow(/has no "OS\/2" table/);
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+41"] })),
  ).rejects.toThrow(ConfigError);
});

test("a src naming a font collection is a wiring fault, not a crash", async () => {
  const face = buildFontFixture({ codepoints: [0x41] });
  const header = Buffer.alloc(20);
  header.write("ttcf", 0, "ascii");
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(2, 8);
  header.writeUInt32BE(20, 12);
  header.writeUInt32BE(20, 16);
  writeFileSync(srcPath, Buffer.concat([header, Buffer.from(face)]));
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+41"] })),
  ).rejects.toThrow(ConfigError);
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+41"] })),
  ).rejects.toThrow(/is a font collection, not a single face/);
});

test("a declared range that is not a unicode-range value is refused, naming the face and the value", async () => {
  writeSourceFixture();
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+zz"] })),
  ).rejects.toThrow(ConfigError);
  await expect(
    defineFontSubset().subset(request({ unicodeRanges: ["U+zz"] })),
  ).rejects.toThrow(
    new RegExp(
      `Font "Acme Sans" \\("${srcPath.replace(/[.\\/]/g, "\\$&")}"\\): "U\\+zz" is not a value "unicodeRanges" takes`,
    ),
  );
});

test("the subset is WOFF2, whatever format the source font arrived in", async () => {
  writeSourceFixture();
  const result = await defineFontSubset().subset(request({ unicodeRanges: ["U+41-42"] }));
  // `wOF2`. The source fixture is a bare TTF, so echoing its format fails this.
  expect(Array.from(result.bytes.slice(0, 4))).toEqual([0x77, 0x4f, 0x46, 0x32]);
});
