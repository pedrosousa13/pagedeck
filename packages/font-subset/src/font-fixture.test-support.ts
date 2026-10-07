function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, false);
  return b;
}
function i16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, false);
  return b;
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
function i32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(i * 2, text.charCodeAt(i), false);
  }
  return out;
}

function triangleGlyph(): Uint8Array {
  const points: [number, number][] = [
    [100, 0],
    [500, 0],
    [300, 700],
  ];
  let px = 0;
  let py = 0;
  const deltas = points.map(([x, y]) => {
    const d: [number, number] = [x - px, y - py];
    px = x;
    py = y;
    return d;
  });
  const header = concat([i16(1), i16(100), i16(0), i16(500), i16(700)]);
  const endPts = u16(points.length - 1);
  const instructionLength = u16(0);
  const flags = Uint8Array.from(points, () => 0x01);
  const xCoords = concat(deltas.map(([dx]) => i16(dx)));
  const yCoords = concat(deltas.map(([, dy]) => i16(dy)));
  const glyph = concat([header, endPts, instructionLength, flags, xCoords, yCoords]);
  return glyph.length % 2 === 0 ? glyph : concat([glyph, new Uint8Array(1)]);
}

function buildPostTable(isFixedPitch: boolean): Uint8Array {
  return concat([
    u32(0x00030000),
    i32(0),
    i16(-100),
    i16(50),
    u32(isFixedPitch ? 1 : 0),
    u32(0), u32(0), u32(0), u32(0),
  ]);
}

function buildNameTable(family: string): Uint8Array {
  const records: { id: number; text: string }[] = [
    { id: 1, text: family },
    { id: 2, text: "Regular" },
    { id: 3, text: `${family};1.000` },
    { id: 4, text: family },
    { id: 6, text: family.replace(/\s+/g, "") },
  ];
  const strings = records.map((record) => utf16be(record.text));
  let offset = 0;
  const nameRecords: Uint8Array[] = [];
  for (const [index, record] of records.entries()) {
    const bytes = strings[index];
    if (bytes === undefined) continue;
    nameRecords.push(
      concat([
        u16(3),
        u16(1),
        u16(0x0409),
        u16(record.id),
        u16(bytes.length),
        u16(offset),
      ]),
    );
    offset += bytes.length;
  }
  const header = concat([u16(0), u16(records.length), u16(6 + records.length * 12)]);
  return concat([header, ...nameRecords, ...strings]);
}

export interface FontFixtureOptions {
  readonly unitsPerEm?: number;
  readonly ascent?: number;
  readonly descent?: number;
  readonly lineGap?: number;
  readonly xHeight?: number;
  readonly isFixedPitch?: boolean;
  readonly omitPost?: boolean;
  readonly codepoints: readonly number[];
}

const DEFAULTS = {
  unitsPerEm: 1000,
  ascent: 800,
  // Negative, as in a real font's `hhea`, so the sign `subsetFont` undoes is exercised.
  descent: -200,
  lineGap: 90,
  xHeight: 500,
};

function buildOs2(unitsPerEm: number, ascent: number, descent: number, xHeight: number): Uint8Array {
  return concat([
    u16(2),
    i16(0),
    u16(400),
    u16(5),
    u16(0),
    i16(0), i16(0), i16(0), i16(0),
    i16(0), i16(0), i16(0), i16(0),
    i16(0), i16(0),
    i16(0),
    new Uint8Array(10),
    u32(0), u32(0), u32(0), u32(0),
    ascii("NONE"),
    u16(0x0040),
    u16(0), u16(0xffff),
    i16(ascent), i16(-Math.abs(descent)), i16(0),
    u16(ascent), u16(Math.abs(descent)),
    u32(1), u32(0),
    i16(xHeight), i16(Math.round(unitsPerEm * 0.7)), u16(0), u16(0), u16(0),
  ]);
}

export function buildFontFixture(options: FontFixtureOptions): Uint8Array {
  const unitsPerEm = options.unitsPerEm ?? DEFAULTS.unitsPerEm;
  const ascent = options.ascent ?? DEFAULTS.ascent;
  const descent = options.descent ?? DEFAULTS.descent;
  const lineGap = options.lineGap ?? DEFAULTS.lineGap;
  const xHeight = options.xHeight ?? DEFAULTS.xHeight;
  const numGlyphs = 1 + options.codepoints.length;

  const glyphs = Array.from({ length: numGlyphs }, () => triangleGlyph());
  const glyf = concat(glyphs);
  const locaOffsets: number[] = [];
  let offset = 0;
  for (const glyph of glyphs) {
    locaOffsets.push(offset);
    offset += glyph.length;
  }
  locaOffsets.push(offset);
  const loca = concat(locaOffsets.map((o) => u16(o / 2)));

  const head = concat([
    u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5),
    u16(0), u16(unitsPerEm),
    i32(0), i32(0), i32(0), i32(0),
    i16(0), i16(0), i16(1000), i16(1000),
    u16(0), u16(8), i16(2), i16(0), i16(0),
  ]);

  const hhea = concat([
    u32(0x00010000), i16(ascent), i16(descent), i16(lineGap),
    u16(700), i16(0), i16(0), i16(700),
    i16(1), i16(0), i16(0),
    i16(0), i16(0), i16(0), i16(0),
    i16(0), u16(numGlyphs),
  ]);

  const maxp = concat([
    u32(0x00010000), u16(numGlyphs),
    u16(0), u16(0), u16(0), u16(0), u16(1), u16(0), u16(0),
    u16(0), u16(0), u16(0), u16(0), u16(0), u16(0),
  ]);

  const hmtx = concat(Array.from({ length: numGlyphs }, () => concat([u16(700), i16(0)])));

  const os2 = buildOs2(unitsPerEm, ascent, descent, xHeight);
  const post = buildPostTable(options.isFixedPitch ?? false);
  const name = buildNameTable("Test Fixture");

  const groups = options.codepoints.map((cp, i) =>
    concat([u32(cp), u32(cp), u32(i + 1)]),
  );
  const subtable = concat([
    u16(12), u16(0), u32(16 + groups.length * 12), u32(0), u32(groups.length),
    ...groups,
  ]);
  const cmap = concat([u16(0), u16(1), u16(3), u16(10), u32(12), subtable]);

  const tables: Record<string, Uint8Array> = {
    "OS/2": os2,
    cmap,
    glyf,
    head,
    hhea,
    hmtx,
    loca,
    maxp,
    name,
    ...(options.omitPost === true ? {} : { post }),
  };
  const tags = Object.keys(tables).sort();
  const numTables = tags.length;
  let searchRangePow = 1;
  let entrySelector = 0;
  while (searchRangePow * 2 <= numTables) {
    searchRangePow *= 2;
    entrySelector++;
  }
  const searchRange = searchRangePow * 16;
  const rangeShift = numTables * 16 - searchRange;
  const headerSize = 12 + numTables * 16;

  let dataOffset = headerSize;
  const records: Uint8Array[] = [];
  const dataParts: Uint8Array[] = [];
  for (const tag of tags) {
    const table = tables[tag];
    if (table === undefined) continue;
    const len = table.length;
    const pad = (4 - (len % 4)) % 4;
    const padded = pad === 0 ? table : concat([table, new Uint8Array(pad)]);
    records.push(concat([ascii(tag), u32(0), u32(dataOffset), u32(len)]));
    dataParts.push(padded);
    dataOffset += padded.length;
  }

  const sfntHeader = concat([
    u32(0x00010000), u16(numTables), u16(searchRange), u16(entrySelector), u16(rangeShift),
  ]);

  return concat([sfntHeader, ...records, ...dataParts]);
}
