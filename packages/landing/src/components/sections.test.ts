import { expect, test } from "vitest";
import { splitSections, tabbed } from "./sections.js";

const TABLE = [
  "<table>",
  "<thead><tr><th>Framework</th><th>JavaScript</th><th>Note</th></tr></thead>",
  "<tbody><tr><td>Next.js</td><td>133.1 kB</td><td></td></tr>",
  "<tr><td>This <em>one</em></td><td>0 B</td><td>One byte more fails.</td></tr></tbody>",
  "</table>",
].join("\n");
const FIGURES = [
  { name: "Next.js", value: "133.1 kB", bytes: 133_100, note: "" },
  { name: "This <em>one</em>", value: "0 B", bytes: 0, note: "One byte more fails." },
];
const PLAIN = "<table>\n<thead><tr><th>Question</th><th>This <em>one</em></th></tr></thead>\n<tbody><tr><td>A</td><td>B</td></tr></tbody>\n</table>";
const WRAPPED =
  '<div class="fw-table" tabindex="0"><table>\n<thead><tr><th>Question</th><th>This <em>one</em></th></tr></thead>\n<tbody><tr><th scope="row" data-label="Question">A</th><td data-label="This one">B</td></tr></tbody>\n</table></div>';

test("the table before the first level-2 heading is the ruler's rows, one per row, and each heading opens a section", () => {
  const html = [
    TABLE,
    '<h2 id="what">What</h2>',
    "<p>One.</p>",
    '<h2 id="why">Why</h2>',
    "<ul><li>Two</li></ul>",
  ].join("\n");

  expect(splitSections(html)).toEqual({
    figures: FIGURES,
    sections: [
      { id: "what", html: '<h2 id="what">What</h2>\n<p>One.</p>\n' },
      { id: "why", html: '<h2 id="why">Why</h2>\n<ul><li>Two</li></ul>' },
    ],
  });
});

test("every table in a section is put in a container that scrolls sideways, each row headed by its first cell and each cell labelled by its column", () => {
  const html = `${TABLE}\n<h2 id="a">A</h2>\n${PLAIN}\n<p>after</p>`;
  expect(splitSections(html).sections).toEqual([
    { id: "a", html: `<h2 id="a">A</h2>\n${WRAPPED}\n<p>after</p>` },
  ]);
});

test("a level-3 heading stays inside its section", () => {
  const body = '<h2 id="a">A</h2><h3 id="b">B</h3><p>x</p>';
  expect(splitSections(TABLE + body).sections).toEqual([{ id: "a", html: body }]);
});

test("a heading inside a code sample is text, not a section", () => {
  const html = `${TABLE}<h2 id="a">A</h2><pre><code>&lt;h2 id="b"&gt;</code></pre>`;
  expect(splitSections(html).sections).toHaveLength(1);
});

test("a document with no table before its first heading is refused, rather than rendering an empty ruler", () => {
  expect(() => splitSections('<h2 id="a">A</h2><p>x</p>')).toThrow(
    /Front page: found no table before the first "##" of content\/index\.md, and the payload ruler under the hero is that table/,
  );
  expect(() => splitSections("")).toThrow(/found no table/);
});

test("anything but the one table before the first heading is refused, rather than set in the ruler", () => {
  expect(() => splitSections(`<p>Intro.</p>\n${TABLE}\n<h2 id="a">A</h2>`)).toThrow(
    /Front page: the markup before the first "##" of content\/index\.md must be one table and nothing else, and it also holds "<p>Intro.<\/p>" — the template sets that markup as the payload ruler/,
  );
  expect(() => splitSections(`${TABLE}\n${TABLE}\n<h2 id="a">A</h2>`)).toThrow(
    /must be one table and nothing else/,
  );
});

test("a column heading's quote is escaped in the label its cells carry, so the attribute stays whole", () => {
  const quoted =
    '<table>\n<thead><tr><th>Question</th><th>Says &quot;hi&quot; & "bye"</th></tr></thead>\n<tbody><tr><td>A</td><td>B</td></tr></tbody>\n</table>';
  const [section] = splitSections(`${TABLE}\n<h2 id="a">A</h2>\n${quoted}`).sections;
  expect(section?.html).toContain('<td data-label="Says &quot;hi&quot; &amp; &quot;bye&quot;">B</td>');
});

test("a ruler row whose figure is not in the site's spelling is refused, naming the row and the file", () => {
  const html = TABLE.replace("133.1 kB", "133 KB");
  expect(() => splitSections(`${html}\n<h2 id="a">A</h2>`)).toThrow(
    /Front page: the payload ruler's row "Next\.js" in content\/index\.md has the figure "133 KB", which is not in the site's spelling — write whole bytes below 1,000 \("307 B"\) or SI kilobytes to one decimal \("3\.1 kB"\)/,
  );
});

test("a ruler table that is not three columns is refused, naming the columns it needs", () => {
  expect(() => splitSections(`${PLAIN}\n<h2 id="a">A</h2>`)).toThrow(
    /Front page: the table before the first "##" of content\/index\.md has 2 columns, and the payload ruler reads three: who, the figure and a note/,
  );
});

test("a level-2 heading with no id is refused, because the section is labelled by it", () => {
  expect(() => splitSections(`${TABLE}<h2>Untitled</h2>`)).toThrow(
    /level-2 heading "<h2>Untitled<\/h2>" carries no id/,
  );
});

const INTRO = "<p>The code behind a page.</p>\n";
const TAB_A = '<h3 id="a-tsx">a.tsx</h3>\n<pre class="shiki"><code>one</code></pre>\n';
const TAB_B = '<h3 id="b-tsx"><code>b.tsx</code></h3>\n<pre class="shiki"><code>two</code></pre>\n<p>After.</p>\n';

test("a section's level-3 blocks become tabs: a radio per heading, labelled by it, and a panel per block", () => {
  expect(tabbed(`<h2 id="code">Code</h2>\n${INTRO}${TAB_A}${TAB_B}`, "code")).toBe(
    [
      `<h2 id="code">Code</h2>\n${INTRO}`,
      '<div class="fw-tabs">',
      '<fieldset class="fw-tabs__list" aria-labelledby="code">',
      '<input type="radio" class="fw-tabs__radio" name="code-tab" id="code-tab-1" checked>',
      '<label for="code-tab-1">a.tsx</label>',
      '<input type="radio" class="fw-tabs__radio" name="code-tab" id="code-tab-2">',
      '<label for="code-tab-2"><code>b.tsx</code></label>',
      "</fieldset>",
      '<div class="fw-tabs__panel">\n<pre class="shiki"><code>one</code></pre>\n</div>',
      '<div class="fw-tabs__panel">\n<pre class="shiki"><code>two</code></pre>\n<p>After.</p>\n</div>',
      "</div>",
    ].join(""),
  );
});

test("a tabbed section needs two to three level-3 blocks, and is refused otherwise", () => {
  expect(() => tabbed(`<h2 id="code">Code</h2>${TAB_A}`, "code")).toThrow(
    /Front page: the "code" section of content\/index\.md is laid out as tabs, one per "###" block, and it has 1 — give it two or three "###" blocks, or take it out of the tabbed layout/,
  );
  expect(() => tabbed(`<h2 id="code">Code</h2>${TAB_A}${TAB_A}${TAB_A}${TAB_A}`, "code")).toThrow(
    /and it has 4/,
  );
});
