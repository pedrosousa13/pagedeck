import { expect, test } from "vitest";
import { tokenize } from "./tokens.js";

test("text is lowercased and split on everything that is not a word", () => {
  expect(tokenize("Build — the Site, twice!")).toEqual([
    "build",
    "the",
    "site",
    "twice",
  ]);
});

test("a repeated term is a repeated token, because frequency is counted", () => {
  expect(tokenize("site site")).toEqual(["site", "site"]);
});

test("digits are terms, and a version is split at its dots", () => {
  expect(tokenize("React 19.1")).toEqual(["react", "19", "1"]);
});

test("letters outside ASCII are word characters", () => {
  expect(tokenize("Straße Ökonomie Ελλάδα Привет")).toEqual([
    "straße",
    "ökonomie",
    "ελλάδα",
    "привет",
  ]);
});

test("a combining mark stays inside the word it is part of", () => {
  expect(tokenize("हिन्दी")).toEqual(["हिन्दी"]);
});

test("a decomposed word and a composed one are the same term", () => {
  expect(tokenize("caf\u00e9")).toEqual(["caf\u00e9"]);
  expect(tokenize("cafe\u0301")).toEqual(["caf\u00e9"]);
});

test("nothing is stemmed, so a plural is its own term", () => {
  expect(tokenize("loader loaders loading")).toEqual([
    "loader",
    "loaders",
    "loading",
  ]);
});

test("text with no word characters yields no tokens", () => {
  expect(tokenize("— … !")).toEqual([]);
});
