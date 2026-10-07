import { ConfigError } from "@pagedeck/core";
import { expect, test } from "vitest";
import { isCodepointInRanges, parseUnicodeRange } from "./unicode-range.js";

const FACE = { family: "Acme Sans", src: "/site/fonts/acme.ttf" } as const;

test("a codepoint pair parses to its two ends", () => {
  expect(parseUnicodeRange("U+41-5A", FACE)).toEqual({ start: 0x41, end: 0x5a });
});

test("the widest pair core admits parses to the full Unicode span", () => {
  expect(parseUnicodeRange("U+0-10FFFF", FACE)).toEqual({ start: 0, end: 0x10ffff });
});

test("a single codepoint is a span of one", () => {
  expect(parseUnicodeRange("U+41", FACE)).toEqual({ start: 0x41, end: 0x41 });
});

test("a trailing wildcard spans every codepoint the replaced digits admit", () => {
  expect(parseUnicodeRange("U+4??", FACE)).toEqual({ start: 0x400, end: 0x4ff });
});

test("a single-digit wildcard spans sixteen codepoints", () => {
  expect(parseUnicodeRange("U+4?", FACE)).toEqual({ start: 0x40, end: 0x4f });
});

test("parsing is case-insensitive on the hex digits", () => {
  expect(parseUnicodeRange("u+4a-4f", FACE)).toEqual({ start: 0x4a, end: 0x4f });
});

test("a codepoint inside any listed range is in range", () => {
  const ranges = [parseUnicodeRange("U+41-5A", FACE), parseUnicodeRange("U+61-7A", FACE)];
  expect(isCodepointInRanges(0x42, ranges)).toBe(true);
  expect(isCodepointInRanges(0x62, ranges)).toBe(true);
});

test("a codepoint outside every listed range is not in range", () => {
  const ranges = [parseUnicodeRange("U+41-5A", FACE)];
  expect(isCodepointInRanges(0x39, ranges)).toBe(false);
});

test("a value that is not a unicode range names the face, the field, the value and the grammar", () => {
  expect(() => parseUnicodeRange("U+zz", FACE)).toThrow(
    'Font "Acme Sans" ("/site/fonts/acme.ttf"): "U+zz" is not a value "unicodeRanges" takes — write each range as U+<hex>, U+<hex>-<hex>, or U+<hex>? with trailing "?" wildcards, such as "U+0000-00FF"',
  );
});

test("a value that is not a unicode range is a wiring fault, not a crash", () => {
  expect(() => parseUnicodeRange("U+zz", FACE)).toThrow(ConfigError);
});
