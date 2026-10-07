import { expect, test } from "vitest";
import {
  fallbackFontFaceRule,
  fallbackMetricsFor,
  fontFaceRule,
  fontPreloadLink,
  fontsFaultReport,
  WEB_SAFE_FALLBACK_METRICS,
} from "./fonts.js";
import type { FontFace, FontMetrics } from "./fonts.js";

const WEB_FONT: FontMetrics = {
  unitsPerEm: 1000,
  ascent: 950,
  descent: 250,
  lineGap: 0,
  xHeight: 520,
};

const FACE: FontFace = {
  family: "Acme Sans",
  src: "/site/fonts/acme-sans.ttf",
  weight: 400,
  style: "normal",
  display: "swap",
  aboveFold: true,
  unicodeRanges: ["U+0000-00FF"],
  fallback: ["Georgia"],
};

const HREF = "/fonts/acme-sans.a1b2c3.woff2";

test("fontFaceRule emits the web font's own @font-face, byte for byte", () => {
  expect(fontFaceRule(FACE, HREF)).toBe(
    [
      "@font-face {",
      '  font-family: "Acme Sans";',
      '  src: url("/fonts/acme-sans.a1b2c3.woff2") format("woff2");',
      "  font-weight: 400;",
      "  font-style: normal;",
      "  font-display: swap;",
      "  unicode-range: U+0000-00FF;",
      "}",
    ].join("\n"),
  );
});

test("fontFaceRule quotes a family holding a double quote", () => {
  const face: FontFace = { ...FACE, family: 'My "Font"' };
  expect(fontFaceRule(face, HREF)).toContain('font-family: "My \\"Font\\"";');
});

test("fontFaceRule omits the format() hint for an unrecognized extension", () => {
  expect(fontFaceRule(FACE, "/fonts/acme-sans.a1b2c3.eot")).toBe(
    [
      "@font-face {",
      '  font-family: "Acme Sans";',
      '  src: url("/fonts/acme-sans.a1b2c3.eot");',
      "  font-weight: 400;",
      "  font-style: normal;",
      "  font-display: swap;",
      "  unicode-range: U+0000-00FF;",
      "}",
    ].join("\n"),
  );
});

test("fontFaceRule emits every declared range, comma-joined, for a face with two", () => {
  const face: FontFace = {
    ...FACE,
    unicodeRanges: ["U+0000-00FF", "U+0131"],
  };
  expect(fontFaceRule(face, HREF)).toBe(
    [
      "@font-face {",
      '  font-family: "Acme Sans";',
      '  src: url("/fonts/acme-sans.a1b2c3.woff2") format("woff2");',
      "  font-weight: 400;",
      "  font-style: normal;",
      "  font-display: swap;",
      "  unicode-range: U+0000-00FF, U+0131;",
      "}",
    ].join("\n"),
  );
});

test("fontFaceRule omits the unicode-range descriptor for a face that declared no ranges", () => {
  const face: FontFace = { ...FACE, unicodeRanges: [] };
  expect(fontFaceRule(face, HREF)).toBe(
    [
      "@font-face {",
      '  font-family: "Acme Sans";',
      '  src: url("/fonts/acme-sans.a1b2c3.woff2") format("woff2");',
      "  font-weight: 400;",
      "  font-style: normal;",
      "  font-display: swap;",
      "}",
    ].join("\n"),
  );
});

test("fallbackFontFaceRule writes the web font's metrics per em, each divided by size-adjust", () => {
  const georgia = WEB_SAFE_FALLBACK_METRICS["Georgia"] as FontMetrics;
  // size-adjust = (520/1000) / (986/2048) = 1.08008113, so 108.0081%. Each override is
  // the font's own ratio over it: 0.95 / 1.08008113 and 0.25 / 1.08008113.
  expect(
    fallbackFontFaceRule({
      family: "Georgia",
      weight: 400,
      style: "normal",
      webFont: WEB_FONT,
      fallback: georgia,
    }),
  ).toBe(
    [
      "@font-face {",
      '  font-family: "Georgia";',
      '  src: local("Georgia");',
      "  font-weight: 400;",
      "  font-style: normal;",
      "  size-adjust: 108.0081%;",
      "  ascent-override: 87.9564%;",
      "  descent-override: 23.1464%;",
      "  line-gap-override: 0.0000%;",
      "}",
    ].join("\n"),
  );
});

test("the fallback paints the web font's own line box, which is what the overrides are for", () => {
  // Resolved the way a browser does, override x font-size x size-adjust: a check on the
  // percentage strings passed while the overrides were 8.01% out.
  const georgia = WEB_SAFE_FALLBACK_METRICS["Georgia"] as FontMetrics;
  const rule = fallbackFontFaceRule({
    family: "Georgia",
    weight: 400,
    style: "normal",
    webFont: WEB_FONT,
    fallback: georgia,
  });
  const percent = (descriptor: string): number => {
    const match = new RegExp(`${descriptor}: ([0-9.]+)%`).exec(rule);
    if (match?.[1] === undefined) {
      throw new Error(`the rule declares no ${descriptor}`);
    }
    return Number(match[1]) / 100;
  };
  const sizeAdjust = percent("size-adjust");
  const fontSize = 100;
  const painted = (descriptor: string): number =>
    percent(descriptor) * fontSize * sizeAdjust;

  expect(painted("ascent-override")).toBeCloseTo(
    (WEB_FONT.ascent / WEB_FONT.unitsPerEm) * fontSize,
    3,
  );
  expect(painted("descent-override")).toBeCloseTo(
    (WEB_FONT.descent / WEB_FONT.unitsPerEm) * fontSize,
    3,
  );
  expect((georgia.xHeight / georgia.unitsPerEm) * fontSize * sizeAdjust).toBeCloseTo(
    (WEB_FONT.xHeight / WEB_FONT.unitsPerEm) * fontSize,
    3,
  );
});

test("fallbackFontFaceRule quotes a family holding a double quote", () => {
  const rule = fallbackFontFaceRule({
    family: 'My "Font"',
    weight: 400,
    style: "normal",
    webFont: WEB_FONT,
    fallback: WEB_SAFE_FALLBACK_METRICS["Georgia"] as FontMetrics,
  });
  expect(rule).toContain('font-family: "My \\"Font\\"";');
  expect(rule).toContain('src: local("My \\"Font\\"");');
});

test("fallbackMetricsFor answers Arial, Helvetica, Georgia, Times New Roman and Courier New with no metrics declared", () => {
  for (const family of [
    "Arial",
    "Helvetica",
    "Georgia",
    "Times New Roman",
    "Courier New",
  ]) {
    expect(fallbackMetricsFor(family)).toBeDefined();
  }
});

test("fallbackMetricsFor answers undefined for a family outside the table with no override", () => {
  expect(fallbackMetricsFor("Brand Grotesk")).toBeUndefined();
});

test("fallbackMetricsFor prefers a site's own override over the table", () => {
  const override: FontMetrics = {
    unitsPerEm: 1000,
    ascent: 1,
    descent: 1,
    lineGap: 1,
    xHeight: 1,
  };
  expect(fallbackMetricsFor("Arial", { Arial: override })).toBe(override);
});

test("fallbackMetricsFor answers a site's override for a family outside the table", () => {
  const override: FontMetrics = {
    unitsPerEm: 1000,
    ascent: 900,
    descent: 200,
    lineGap: 0,
    xHeight: 500,
  };
  expect(fallbackMetricsFor("Brand Grotesk", { "Brand Grotesk": override })).toBe(override);
});

test("fontPreloadLink emits a preload for an above-fold face, with crossorigin", () => {
  expect(fontPreloadLink(FACE, HREF)).toBe(
    '<link rel="preload" href="/fonts/acme-sans.a1b2c3.woff2" as="font" type="font/woff2" crossorigin>',
  );
});

test("fontPreloadLink emits nothing for a below-fold face", () => {
  const face: FontFace = { ...FACE, aboveFold: false };
  expect(fontPreloadLink(face, HREF)).toBeUndefined();
});

test("fontPreloadLink emits nothing for a face that declared no aboveFold at all", () => {
  const { aboveFold: _aboveFold, ...rest } = FACE;
  const face = rest as FontFace;
  expect(fontPreloadLink(face, HREF)).toBeUndefined();
});

test("fontPreloadLink escapes its href the way headElements escapes a <link>", () => {
  expect(fontPreloadLink(FACE, '/fonts/a"b.woff2')).toBe(
    '<link rel="preload" href="/fonts/a&quot;b.woff2" as="font" type="font/woff2" crossorigin>',
  );
});

const VALID_SETTING = {
  adapter: { name: "acme-subsetter", subset: () => ({}) },
  faces: [
    {
      family: "Acme Sans",
      src: "/site/fonts/acme-sans.ttf",
      weight: 400,
      style: "normal",
      display: "swap",
      unicodeRanges: ["U+0-10FFFF"],
      fallback: ["Georgia"],
    },
  ],
};

test("fontsFaultReport passes a well-formed setting", () => {
  expect(fontsFaultReport(VALID_SETTING, "Build settings")).toBeUndefined();
});

test("fontsFaultReport refuses a setting that is not an object", () => {
  expect(fontsFaultReport("nope", "Build settings")).toBe(
    'Build settings: "build.fonts" must be an object with an adapter and a list of faces — fonts: { adapter: { name: "acme-subsetter", subset: (request) => ({ bytes, metrics }) }, faces: [{ family: "Acme Sans", src: "/site/fonts/acme-sans.ttf", weight: 400, style: "normal", display: "swap", unicodeRanges: ["U+0-10FFFF"], fallback: ["Georgia"] }] }',
  );
});

test("fontsFaultReport refuses an adapter with no name", () => {
  const setting = { ...VALID_SETTING, adapter: { name: "", subset: () => ({}) } };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.adapter" declares 1 field this build cannot subset through — declare each as the type its own line names:\n  "adapter.name" — "" — not an adapter name — write the name this adapter is reported by, such as "acme-subsetter"',
  );
});

test("fontsFaultReport refuses a non-function subset", () => {
  const setting = { ...VALID_SETTING, adapter: { name: "acme-subsetter", subset: "nope" } };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.adapter" declares 1 field this build cannot subset through — declare each as the type its own line names:\n  "adapter.subset" — "nope" — not a subset function — write the function this build hands one face\'s source and declared ranges to, as subset: (request) => ({ bytes, metrics })',
  );
});

test("fontsFaultReport refuses a face with no family", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], family: "" }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.faces" declares 1 face with no family — give the face its own family name, such as family: "Acme Sans":\n  faces[0]',
  );
});

test("fontsFaultReport refuses a face with no source path", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], src: "" }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.faces" declares 1 face with no source path — point src at the face\'s own source font file, such as src: "/site/fonts/acme-sans.ttf":\n  faces[0] ("Acme Sans")',
  );
});

test("fontsFaultReport refuses a fallback family outside the table with no declared metrics", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], fallback: ["Brand Grotesk"] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.faces" declares 1 fallback family with no metrics — declare "fallbackMetrics" for it, or use one of: Arial, Helvetica, Georgia, Times New Roman, Courier New:\n  faces[0] ("Acme Sans") — "Brand Grotesk"',
  );
});

test("fontsFaultReport accepts a fallback family outside the table once the face declares its own metrics", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [
      {
        ...VALID_SETTING.faces[0],
        fallback: ["Brand Grotesk"],
        fallbackMetrics: {
          "Brand Grotesk": {
            unitsPerEm: 1000,
            ascent: 900,
            descent: 200,
            lineGap: 0,
            xHeight: 500,
          },
        },
      },
    ],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBeUndefined();
});

test("fontsFaultReport does not refuse a generic fallback family", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], fallback: ["sans-serif"] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBeUndefined();
});

test("fontsFaultReport collects every fault of one setting into one report", () => {
  const setting = {
    adapter: { name: "", subset: "nope" },
    faces: [{ family: "", src: "", weight: 400, style: "normal", display: "swap", fallback: [] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    [
      'Build settings: "build.fonts.adapter" declares 2 fields this build cannot subset through — declare each as the type its own line names:\n  "adapter.name" — "" — not an adapter name — write the name this adapter is reported by, such as "acme-subsetter"\n  "adapter.subset" — "nope" — not a subset function — write the function this build hands one face\'s source and declared ranges to, as subset: (request) => ({ bytes, metrics })',
      'Build settings: "build.fonts.faces" declares 1 face with no family — give the face its own family name, such as family: "Acme Sans":\n  faces[0]',
      'Build settings: "build.fonts.faces" declares 1 face with no source path — point src at the face\'s own source font file, such as src: "/site/fonts/acme-sans.ttf":\n  faces[0]',
    ].join("\n\n"),
  );
});

test("fontsFaultReport accepts every well-formed unicode-range form", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [
      {
        ...VALID_SETTING.faces[0],
        unicodeRanges: ["U+0-10FFFF", "U+4??", "U+0041"],
      },
    ],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBeUndefined();
});

test("fontsFaultReport refuses a range that is not the grammar's three forms", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], unicodeRanges: ["not-a-range"] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.faces" declares 1 malformed unicode range — write each range as the CSS unicode-range grammar admits — a pair such as "U+0-10FFFF", a single codepoint such as "U+0041", or a trailing wildcard such as "U+4??":\n  faces[0] ("Acme Sans") — "not-a-range"',
  );
});

test("fontsFaultReport refuses a codepoint above U+10FFFF, alone or as a range's end", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [
      { ...VALID_SETTING.faces[0], unicodeRanges: ["U+110000", "U+0-110000"] },
    ],
  };
  const report = fontsFaultReport(setting, "Build settings");
  expect(report).toContain("declares 2 malformed unicode ranges");
  expect(report).toContain('faces[0] ("Acme Sans") — "U+110000"');
  expect(report).toContain('faces[0] ("Acme Sans") — "U+0-110000"');
});

test("fontsFaultReport refuses a range whose start is after its end", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], unicodeRanges: ["U+00FF-0000"] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toContain(
    '"U+00FF-0000"',
  );
});

test("fontsFaultReport refuses a non-string range", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], unicodeRanges: [42] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toContain(
    'faces[0] ("Acme Sans") — 42',
  );
});

test("fontsFaultReport collects malformed ranges across faces into one report", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [
      { ...VALID_SETTING.faces[0], unicodeRanges: ["nope"] },
      {
        family: "Acme Mono",
        src: "/site/fonts/acme-mono.ttf",
        weight: 400,
        style: "normal",
        display: "swap",
        unicodeRanges: ["also-nope"],
        fallback: ["Courier New"],
      },
    ],
  };
  const report = fontsFaultReport(setting, "Build settings");
  expect(report).toContain("declares 2 malformed unicode ranges");
  expect(report).toContain('faces[0] ("Acme Sans") — "nope"');
  expect(report).toContain('faces[1] ("Acme Mono") — "also-nope"');
});

test("fontsFaultReport does not refuse a face that declares no unicodeRanges array", () => {
  const { unicodeRanges: _unicodeRanges, ...face } = VALID_SETTING.faces[0];
  const setting = { ...VALID_SETTING, faces: [face] };
  expect(fontsFaultReport(setting, "Build settings")).toBeUndefined();
});

test("two faces of one family at two weights get fallback rules that do not collide", () => {
  const georgia = WEB_SAFE_FALLBACK_METRICS["Georgia"] as FontMetrics;
  const regular = fallbackFontFaceRule({
    family: "Georgia",
    weight: 400,
    style: "normal",
    webFont: WEB_FONT,
    fallback: georgia,
  });
  const semibold = fallbackFontFaceRule({
    family: "Georgia",
    weight: 600,
    style: "normal",
    webFont: { ...WEB_FONT, xHeight: 560 },
    fallback: georgia,
  });

  expect(regular).toContain("  font-weight: 400;");
  expect(semibold).toContain("  font-weight: 600;");
  const descriptors = (rule: string): string =>
    rule
      .split("\n")
      .filter((line) => /font-(weight|style):/.test(line))
      .join("|");
  expect(descriptors(regular)).not.toBe(descriptors(semibold));
  expect(regular).not.toBe(semibold);
});

test("fallbackFontFaceRule carries an italic face's own style", () => {
  const rule = fallbackFontFaceRule({
    family: "Georgia",
    weight: 700,
    style: "italic",
    webFont: WEB_FONT,
    fallback: WEB_SAFE_FALLBACK_METRICS["Georgia"] as FontMetrics,
  });
  expect(rule).toContain("  font-weight: 700;");
  expect(rule).toContain("  font-style: italic;");
});

const MONO_WEB_FONT: FontMetrics = { ...WEB_FONT, monospaceAdvance: 600 };

test("a monospace face with a 0.6 em advance and a 0.6 em fallback gets size-adjust 100%", () => {
  expect(
    fallbackFontFaceRule({
      family: "Acme Mono Fallback",
      weight: 400,
      style: "normal",
      webFont: MONO_WEB_FONT,
      fallback: {
        unitsPerEm: 1000,
        ascent: 800,
        descent: 200,
        lineGap: 0,
        xHeight: 400,
        monospaceAdvance: 600,
      },
    }),
  ).toBe(
    [
      "@font-face {",
      '  font-family: "Acme Mono Fallback";',
      '  src: local("Acme Mono Fallback");',
      "  font-weight: 400;",
      "  font-style: normal;",
      "  size-adjust: 100.0000%;",
      "  ascent-override: 95.0000%;",
      "  descent-override: 25.0000%;",
      "  line-gap-override: 0.0000%;",
      "}",
    ].join("\n"),
  );
});

test("a monospace fallback paints the web font's own glyph advance and line box", () => {
  const courier = WEB_SAFE_FALLBACK_METRICS["Courier New"] as FontMetrics;
  const rule = fallbackFontFaceRule({
    family: "Courier New",
    weight: 400,
    style: "normal",
    webFont: MONO_WEB_FONT,
    fallback: courier,
  });
  const percent = (descriptor: string): number =>
    Number(new RegExp(`${descriptor}: ([0-9.]+)%`).exec(rule)?.[1]) / 100;
  const sizeAdjust = percent("size-adjust");
  const fontSize = 100;
  expect(
    ((courier.monospaceAdvance ?? Number.NaN) / courier.unitsPerEm) * fontSize * sizeAdjust,
  ).toBeCloseTo(0.6 * fontSize, 3);
  expect(percent("ascent-override") * fontSize * sizeAdjust).toBeCloseTo(
    (WEB_FONT.ascent / WEB_FONT.unitsPerEm) * fontSize,
    3,
  );
});

test("a face is sized by advance only when both it and its fallback are monospace", () => {
  const courier = WEB_SAFE_FALLBACK_METRICS["Courier New"] as FontMetrics;
  const georgia = WEB_SAFE_FALLBACK_METRICS["Georgia"] as FontMetrics;
  const { monospaceAdvance: _advance, ...courierProportional } = courier;
  const rule = (webFont: FontMetrics, fallback: FontMetrics): string =>
    fallbackFontFaceRule({ family: "X", weight: 400, style: "normal", webFont, fallback });
  expect(rule(WEB_FONT, courier)).toBe(rule(WEB_FONT, courierProportional));
  expect(rule(MONO_WEB_FONT, georgia)).toBe(rule(WEB_FONT, georgia));
});

test("monospace is read off the metrics, never off the family name", () => {
  const courier = WEB_SAFE_FALLBACK_METRICS["Courier New"] as FontMetrics;
  const { monospaceAdvance: _advance, ...courierProportional } = courier;
  const sizeAdjust = (family: string, fallback: FontMetrics): string | undefined =>
    /size-adjust: ([0-9.]+%)/.exec(
      fallbackFontFaceRule({
        family,
        weight: 400,
        style: "normal",
        webFont: MONO_WEB_FONT,
        fallback,
      }),
    )?.[1];
  // Named like a monospace family, metrics with no advance: x-height.
  // (520/1000) / (866/2048) = 1.22974595...
  expect(sizeAdjust("Courier New", courierProportional)).toBe("122.9746%");
  // Named like a proportional family, fixed-pitch metrics: advance.
  // 0.6 / (1229/2048) = 0.99983726...
  expect(sizeAdjust("Georgia", courier)).toBe("99.9837%");
});

test("the table carries an advance for Courier New and for none of its proportional families", () => {
  expect(WEB_SAFE_FALLBACK_METRICS["Courier New"]?.monospaceAdvance).toBe(1229);
  for (const family of ["Arial", "Helvetica", "Georgia", "Times New Roman"]) {
    expect(WEB_SAFE_FALLBACK_METRICS[family]?.monospaceAdvance).toBeUndefined();
  }
});

test("fontsFaultReport refuses a weight, a style and a display no @font-face can be written from", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [
      { ...VALID_SETTING.faces[0], weight: "400", style: "oblique" },
      {
        family: "Acme Serif",
        src: "/site/fonts/acme-serif.ttf",
        weight: 400,
        style: "normal",
        unicodeRanges: ["U+0-10FFFF"],
        fallback: ["Georgia"],
      },
    ],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    'Build settings: "build.fonts.faces" declares 3 face fields this build cannot write a @font-face from — declare each as the type its own line names:\n' +
      '  faces[0] ("Acme Sans") — "weight" — "400" — not a font weight — write the weight this face is selected by, as a number from 1 to 1000, such as weight: 400\n' +
      '  faces[0] ("Acme Sans") — "style" — "oblique" — not a font style — write one of: normal, italic\n' +
      '  faces[1] ("Acme Serif") — "display" — undefined — not a font-display value — write one of: auto, block, swap, fallback, optional',
  );
});

test("fontsFaultReport accepts every font-display value spec §10 scopes this to", () => {
  for (const display of ["auto", "block", "swap", "fallback", "optional"]) {
    const setting = {
      ...VALID_SETTING,
      faces: [{ ...VALID_SETTING.faces[0], display }],
    };
    expect(fontsFaultReport(setting, "Build settings")).toBeUndefined();
  }
});

test("fontsFaultReport refuses a weight outside the 1 to 1000 CSS range", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], weight: 0 }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toContain(
    'faces[0] ("Acme Sans") — "weight" — 0 — not a font weight',
  );
});

test("fontsFaultReport passes a face scoped to page patterns", () => {
  const setting = {
    ...VALID_SETTING,
    faces: [{ ...VALID_SETTING.faces[0], pages: ["/features", "en:/blog/**"] }],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBeUndefined();
});

test("fontsFaultReport refuses a scope that is not a list of page patterns, one line per fault", () => {
  const face = VALID_SETTING.faces[0];
  const setting = {
    ...VALID_SETTING,
    faces: [
      { ...face, pages: [] },
      { ...face, family: "Acme Mono", pages: "/features" },
      { ...face, family: "Acme Serif", pages: ["features", 42, ":/x"] },
    ],
  };
  expect(fontsFaultReport(setting, "Build settings")).toBe(
    [
      'Build settings: "build.fonts.faces" declares 5 page scopes this build cannot read — write "pages" as a list of page patterns, each a path starting with "/" and optionally prefixed "<locale>:", such as pages: ["/features", "en:/blog/**"], or leave "pages" out to link the face on every page:',
      '  faces[0] ("Acme Sans") — [] — an empty list, which links the face on no page',
      '  faces[1] ("Acme Mono") — "/features" — not a list',
      '  faces[2] ("Acme Serif") — "features" — the path does not start with "/"',
      '  faces[2] ("Acme Serif") — 42 — not a page pattern',
      '  faces[2] ("Acme Serif") — ":/x" — the locale scope before ":" is empty',
    ].join("\n"),
  );
});
