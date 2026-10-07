import { expect, test } from "vitest";
import { extractText } from "./text.js";

test("tags are stripped and the text between them is kept", () => {
  const { sections } = extractText("<p>Hello <em>there</em>, reader.</p>");
  expect(sections).toEqual([
    { heading: null, text: "Hello there , reader." },
  ]);
});

test("a heading opens a section, and its own text is not the section's body", () => {
  const { sections } = extractText(
    "<p>Lead.</p><h2>Install</h2><p>Run it.</p><h3>Notes</h3><p>Read it.</p>",
  );
  expect(sections).toEqual([
    { heading: null, text: "Lead." },
    { heading: { text: "Install" }, text: "Run it." },
    { heading: { text: "Notes" }, text: "Read it." },
  ]);
});

test("script, style and template contents are dropped, not indexed", () => {
  const { sections } = extractText(
    "<p>Kept.</p>" +
      "<script>const dropped = 1;</script>" +
      "<style>.dropped { color: red }</style>" +
      "<template><p>dropped</p></template>",
  );
  expect(sections).toEqual([{ heading: null, text: "Kept." }]);
});

test('an aria-hidden="true" subtree is dropped whole, nesting included', () => {
  const { sections } = extractText(
    '<p>Kept.</p><div aria-hidden="true"><p>dropped <span>dropped</span></p></div><p>After.</p>',
  );
  expect(sections).toEqual([{ heading: null, text: "Kept. After." }]);
});

test('aria-hidden="false" is not hidden, so its text is kept', () => {
  const { sections } = extractText('<div aria-hidden="false">Kept.</div>');
  expect(sections).toEqual([{ heading: null, text: "Kept." }]);
});

test("a hidden element is dropped whole", () => {
  const { sections } = extractText("<p hidden>dropped</p><p>Kept.</p>");
  expect(sections).toEqual([{ heading: null, text: "Kept." }]);
});

test("a heading inside a hidden subtree opens no section", () => {
  const { sections } = extractText(
    '<div hidden><h2>Dropped</h2><p>dropped</p></div><p>Kept.</p>',
  );
  expect(sections).toEqual([{ heading: null, text: "Kept." }]);
});

test('a data-fw-search="ignore" subtree is dropped whole, nesting included', () => {
  // Written out, not imported: a test built from the reader's constant passes through a rename.
  const { sections } = extractText(
    '<p>Kept.</p><nav data-fw-search="ignore"><p>Contents</p>' +
      "<ul><li><a>Other page</a></li></ul></nav><p>After.</p>",
  );
  expect(sections).toEqual([{ heading: null, text: "Kept. After." }]);
});

test('a heading inside a data-fw-search="ignore" subtree opens no section', () => {
  const { sections } = extractText(
    '<nav data-fw-search="ignore"><h2>Guides</h2><a>Other page</a></nav>' +
      "<h2>Own</h2><p>Kept.</p>",
  );
  expect(sections).toEqual([{ heading: { text: "Own" }, text: "Kept." }]);
});

test('only the value "ignore" drops an element carrying data-fw-search', () => {
  const { sections } = extractText('<div data-fw-search="">Kept.</div>');
  expect(sections).toEqual([{ heading: null, text: "Kept." }]);
});

test("the six references React's serializer writes are decoded", () => {
  const { sections } = extractText(
    "<p>Tools &amp; Tips &lt;here&gt; &quot;quoted&quot; &#x27;a&#39;</p>",
  );
  expect(sections).toEqual([
    { heading: null, text: `Tools & Tips <here> "quoted" 'a'` },
  ]);
});

test("a reference this renderer does not write is left as its own text", () => {
  const { sections } = extractText("<p>a &nbsp; b</p>");
  expect(sections).toEqual([{ heading: null, text: "a &nbsp; b" }]);
});

test("an ampersand a document escaped is not decoded twice", () => {
  const { sections } = extractText("<p>&amp;lt;</p>");
  expect(sections).toEqual([{ heading: null, text: "&lt;" }]);
});

test("comments and the doctype hold no indexable text", () => {
  const { sections } = extractText("<!-- dropped --><p>Kept.</p>");
  expect(sections).toEqual([{ heading: null, text: "Kept." }]);
});

test("a void element inside a heading does not end it", () => {
  const { sections } = extractText("<h1>Line<br>Break</h1>");
  expect(sections).toEqual([
    { heading: { text: "Line Break" }, text: "" },
  ]);
});

test("a page whose first element is a heading has no lead section", () => {
  const { sections } = extractText("<h1>Title</h1><p>Body.</p>");
  expect(sections).toEqual([
    { heading: { text: "Title" }, text: "Body." },
  ]);
});
