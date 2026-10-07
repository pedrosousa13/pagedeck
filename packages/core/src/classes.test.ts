import { expect, test } from "vitest";
import { classesOfHtml } from "./classes.js";

test("a document with no class attribute uses no classes", () => {
  expect(classesOfHtml("<p>marker-copy-4f81</p>")).toEqual([]);
  expect(classesOfHtml("")).toEqual([]);
});

test("every element's classes are read, in the order the document holds them", () => {
  expect(
    classesOfHtml(
      '<section class="hero"><a class="cta" href="/pricing">Go</a></section>',
    ),
  ).toEqual(["hero", "cta"]);
});

test("a class two elements carry is recorded once", () => {
  expect(
    classesOfHtml('<p class="lede note"></p><p class="note lede"></p>'),
  ).toEqual(["lede", "note"]);
});

test("a class attribute splits on every ASCII whitespace character", () => {
  expect(classesOfHtml('<p class="a  b\nc\td\fe\rf"></p>')).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ]);
});

test("an empty or whitespace-only class attribute contributes nothing", () => {
  expect(classesOfHtml('<p class=""></p><p class="  \n "></p>')).toEqual([]);
});

test("React's escaping is undone, so a class is the one the toolkit wrote", () => {
  expect(
    classesOfHtml(
      '<span class="[&amp;&gt;svg]:mt-2 data-[x=&quot;y&quot;]:flex [&lt;a]:u with&#x27;it"></span>',
    ),
  ).toEqual(["[&>svg]:mt-2", 'data-[x="y"]:flex', "[<a]:u", "with'it"]);
});

test("a character reference this renderer does not write is left as it stands", () => {
  expect(classesOfHtml('<p class="a&nbsp;b"></p>')).toEqual(["a&nbsp;b"]);
});

test("a single-quoted or unquoted value is read, which is content's spelling", () => {
  expect(classesOfHtml("<i class='single'></i><b class=unquoted></b>")).toEqual(
    ["single", "unquoted"],
  );
});

test("a quote of the other kind does not end a value", () => {
  expect(classesOfHtml(`<i class='a"b'></i>`)).toEqual(['a"b']);
});

test("a longer attribute name is not a class attribute", () => {
  expect(classesOfHtml('<p data-class="x" xclass="y" classy="z"></p>')).toEqual(
    [],
  );
});

test("the attribute name is read case-insensitively, as a parser reads it", () => {
  expect(classesOfHtml('<P CLASS="shout"></P>')).toEqual(["shout"]);
});

test("whitespace around the equals sign is where a value may still be", () => {
  expect(classesOfHtml('<p class = "spaced"></p>')).toEqual(["spaced"]);
});
