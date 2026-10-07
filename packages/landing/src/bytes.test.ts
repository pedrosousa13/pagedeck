import { expect, test } from "vitest";
import { formatBytes, isSpelled, parseBytes, utf8Bytes } from "./bytes.js";

test("a count below 1,000 prints as whole bytes, zero included", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(307)).toBe("307 B");
  expect(formatBytes(999)).toBe("999 B");
});

test("a count of 1,000 or more prints as SI kilobytes to one decimal", () => {
  expect(formatBytes(1000)).toBe("1.0 kB");
  expect(formatBytes(3093)).toBe("3.1 kB");
  expect(formatBytes(67096)).toBe("67.1 kB");
  expect(formatBytes(133_120)).toBe("133.1 kB");
  expect(formatBytes(452_538)).toBe("452.5 kB");
});

test("a string's size is its UTF-8 length, not its length in code units", () => {
  expect(utf8Bytes("abc")).toBe(3);
  expect(utf8Bytes("é")).toBe(2);
});

test("a figure as the site prints it reads back as the count it stands for", () => {
  expect(parseBytes("0 B")).toBe(0);
  expect(parseBytes("307 B")).toBe(307);
  expect(parseBytes("133.1 kB")).toBe(133_100);
  expect(parseBytes(formatBytes(67_096))).toBe(67_100);
});

test("a figure not in the site's spelling is refused, naming the spelling", () => {
  expect(() => parseBytes("133 KB")).toThrow(
    /Byte figure "133 KB" is not in the site's spelling — write whole bytes below 1,000 \("307 B"\) or SI kilobytes to one decimal \("3\.1 kB"\)/,
  );
});

test("only a figure in the site's spelling counts as spelled", () => {
  expect(isSpelled("0 B")).toBe(true);
  expect(isSpelled("133.1 kB")).toBe(true);
  expect(isSpelled("133 kB")).toBe(false);
  expect(isSpelled("1,000 B")).toBe(false);
});
