import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createMarkdownRenderer } from "./render.js";

const renderer = await createMarkdownRenderer({ languages: ["ts"] });

test("markdown becomes the HTML its structure describes", async () => {
  const rendered = await renderer.render("## Section\n\nText.\n", "docs/a.md");
  expect(rendered.html).toContain('<h2 id="section">Section</h2>');
  expect(rendered.html).toContain("<p>Text.</p>");
});

test("the heading that became the title is taken out of the body", async () => {
  const rendered = await renderer.render("# Title\n\nText.\n", "docs/a.md");
  expect(rendered.title).toBe("Title");
  expect(rendered.html).not.toContain("<h1>");
  expect(rendered.html).toContain("<p>Text.</p>");
});

test("a second level-1 heading stays in the body", async () => {
  const rendered = await renderer.render("# One\n\n# Two\n", "docs/a.md");
  expect(rendered.title).toBe("One");
  expect(rendered.html).toContain('<h1 id="two">Two</h1>');
});

test("the first level-1 heading is the document's title", async () => {
  const rendered = await renderer.render("# Getting started\n\n## Next\n", "d.md");
  expect(rendered.title).toBe("Getting started");
});

test("a document with no level-1 heading reports no title of its own", async () => {
  const rendered = await renderer.render("## Only a subheading\n", "d.md");
  expect(rendered.title).toBeUndefined();
});

test("a fenced block is highlighted into the markup, with no script anywhere", async () => {
  const rendered = await renderer.render(
    "```ts\nconst x: number = 1;\n```\n",
    "docs/a.md",
  );
  expect(rendered.html).toContain("<pre");
  expect(rendered.html).toMatch(/<span style="color:[^"]+">/);
  expect(rendered.html).not.toContain("<script");
  expect(rendered.html).toContain("const");
});

const FENCE = "```ts\nconst x: number = 1;\n```\n";

test("a single theme renders the bytes it rendered before a pair could be named", async () => {
  // A literal, not a Shiki comparison: a single-theme site must see no change at all.
  const rendered = await renderer.render(FENCE, "docs/a.md");
  expect(rendered.html).toBe(
    '<pre class="shiki github-light" style="background-color:#fff;color:#24292e" tabindex="0"><code><span class="line"><span style="color:#D73A49">const</span><span style="color:#005CC5"> x</span><span style="color:#D73A49">:</span><span style="color:#005CC5"> number</span><span style="color:#D73A49"> =</span><span style="color:#005CC5"> 1</span><span style="color:#24292E">;</span></span></code></pre>',
  );
});

const paired = await createMarkdownRenderer({
  languages: ["ts"],
  theme: { light: "github-light", dark: "github-dark" },
});

function tokenStyles(html: string): string[] {
  return [...html.matchAll(/<span style="([^"]*)">/g)].map((match) => match[1] ?? "");
}

function preStyle(html: string): string {
  return /<pre [^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";
}

test("a pair writes each token's light colour inline and its dark one beside it", async () => {
  const light = (await renderer.render(FENCE, "docs/a.md")).html;
  const html = (await paired.render(FENCE, "docs/a.md")).html;
  const styles = tokenStyles(html);
  expect(styles.length).toBeGreaterThan(1);
  for (const style of styles) {
    expect(style).toMatch(/^color:#[0-9A-Fa-f]+;--shiki-dark:#[0-9A-Fa-f]+$/);
  }
  expect(styles.map((style) => style.split(";")[0])).toEqual(tokenStyles(light));
  const differs = styles.some((style) => {
    const [color, dark] = style.split(";");
    return color?.slice("color:".length) !== dark?.slice("--shiki-dark:".length);
  });
  expect(differs).toBe(true);
});

test("a pair writes the light background inline on the pre and the dark one beside it", async () => {
  const html = (await paired.render(FENCE, "docs/a.md")).html;
  const style = preStyle(html);
  expect(style).toContain("background-color:#fff");
  expect(style).toContain("--shiki-dark-bg:#24292e");
});

test("a pair ships no script, no style element, and no colour a class must supply", async () => {
  const html = (await paired.render(FENCE, "docs/a.md")).html;
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<style");
  expect(html).not.toContain("var(");
});

test("the site rule the README documents is the switch the paired output answers to", async () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  const rule = (/^```css\n([\s\S]*?)^```$/m.exec(readme)?.[1] ?? "").trimEnd();
  expect(rule).toBe(
    [
      '[data-theme="dark"] .shiki,',
      '[data-theme="dark"] .shiki span {',
      "  color: var(--shiki-dark) !important;",
      "  background-color: var(--shiki-dark-bg) !important;",
      "}",
    ].join("\n"),
  );
  const html = (await paired.render(FENCE, "docs/a.md")).html;
  expect(/<pre class="([^"]*)"/.exec(html)?.[1]?.split(" ")).toContain("shiki");
  for (const name of rule.matchAll(/var\((--[\w-]+)\)/g)) {
    expect(preStyle(html)).toContain(`${name[1] ?? ""}:`);
  }
  for (const style of tokenStyles(html)) expect(style).toContain("--shiki-dark:");
});

test("a fence with no language is plain, escaped code", async () => {
  const rendered = await renderer.render("```\n<b>&\n```\n", "docs/a.md");
  expect(rendered.html).toContain("<pre><code>");
  expect(rendered.html).toContain("&lt;b&gt;&amp;");
});

test("every language the renderer was not given is refused, not the first", async () => {
  await expect(
    renderer.render("```rust\nfn a() {}\n```\n\n```go\n\n```\n", "docs/a.md"),
  ).rejects.toThrow(
    'Markdown "docs/a.md": 2 code languages are not loaded, so their fences cannot be highlighted — add each to the loader\'s languages, or drop the language from the fence:\n  go\n  rust',
  );
});

test("one language named by two fences is reported once", async () => {
  await expect(
    renderer.render("```rust\na\n```\n\n```rust\nb\n```\n", "docs/a.md"),
  ).rejects.toThrow(
    'Markdown "docs/a.md": 1 code language is not loaded, so its fences cannot be highlighted — add each to the loader\'s languages, or drop the language from the fence:\n  rust',
  );
});

test("a heading carries an id, and the outline reports the same slug", async () => {
  const rendered = await renderer.render("## Section one\n", "docs/a.md");
  expect(rendered.html).toContain('<h2 id="section-one">Section one</h2>');
  expect(rendered.toc).toEqual([
    { depth: 2, slug: "section-one", text: "Section one" },
  ]);
});

test("two headings with the same text get distinct slugs", async () => {
  const rendered = await renderer.render("## Options\n\n## Options\n", "d.md");
  expect(rendered.html).toContain('<h2 id="options">Options</h2>');
  expect(rendered.html).toContain('<h2 id="options-1">Options</h2>');
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "options",
    "options-1",
  ]);
});

test("a suffix never lands on a slug another heading already owns", async () => {
  // "Options 1" slugs to `options-1`, which the second "Options" would also take.
  const rendered = await renderer.render(
    "## Options 1\n\n## Options\n\n## Options\n",
    "d.md",
  );
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "options-1",
    "options",
    "options-2",
  ]);
});

test("a non-Latin heading keeps its own letters in the slug", async () => {
  const rendered = await renderer.render("## 日本語の見出し\n", "d.md");
  expect(rendered.html).toContain('<h2 id="日本語の見出し">');
  expect(rendered.toc[0]?.slug).toBe("日本語の見出し");
});

test("a heading made only of punctuation still gets a usable id", async () => {
  const rendered = await renderer.render("## ***\n\n## !?\n", "d.md");
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "section",
    "section-1",
  ]);
  expect(rendered.html).toContain('id="section"');
});

function ids(html: string): string[] {
  return [...html.matchAll(/ id="([^"]*)"/g)].map((match) => match[1] ?? "");
}

test("a heading cannot break out of the id attribute it lands in", async () => {
  const rendered = await renderer.render(
    '## Close" onmouseover="alert(1)\n\n## <img src=x onerror=alert(1)>\n\n## a&b\n',
    "d.md",
  );
  for (const id of ids(rendered.html)) {
    expect(id).toMatch(/^[\p{L}\p{N}][\p{L}\p{N}-]*$/u);
  }
  expect(ids(rendered.html)).toEqual(rendered.toc.map((entry) => entry.slug));
});

const RESERVED = /^(?:data-)?fw(?:-|$)/;

test("a heading cannot slug onto the framework's reserved names", async () => {
  const rendered = await renderer.render(
    "## fw-island\n\n## FW Store Push\n\n## fw-fw-nested\n\n## data-fw-slot\n\n## Data FW Props\n\n## database-fw-notes\n\n## fwiw\n",
    "d.md",
  );
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "island",
    "store-push",
    "nested",
    "slot",
    "props",
    "database-fw-notes",
    "fwiw",
  ]);
  for (const id of ids(rendered.html)) {
    expect(id).not.toMatch(RESERVED);
  }
});

test("numbering a repeat cannot walk back into the namespace it was kept out of", async () => {
  const rendered = await renderer.render("## fw\n\n## fw\n\n## fw\n", "d.md");
  for (const id of ids(rendered.html)) {
    expect(id).not.toMatch(RESERVED);
  }
  expect(new Set(ids(rendered.html)).size).toBe(3);
  expect(ids(rendered.html)).toEqual(rendered.toc.map((entry) => entry.slug));
});

test("an apostrophe is dropped from a slug rather than turned into a hyphen", async () => {
  const rendered = await renderer.render(
    "## What's next\n\n## Don’t write what didn’t change\n\n## It can't watch you\n",
    "d.md",
  );
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "whats-next",
    "dont-write-what-didnt-change",
    "it-cant-watch-you",
  ]);
  expect(ids(rendered.html)).toEqual(rendered.toc.map((entry) => entry.slug));
});

test("dropping an apostrophe cannot join a heading onto the reserved names", async () => {
  const rendered = await renderer.render(
    "## fw'-island\n\n## ’fw\n\n## data-fw’-slot\n\n## fw's notes\n\n## It’s fw\n",
    "d.md",
  );
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "island",
    "section",
    "slot",
    "fws-notes",
    "its-fw",
  ]);
  for (const id of ids(rendered.html)) {
    expect(id).not.toMatch(RESERVED);
  }
});

test("a heading's slug comes from its text, never its markup", async () => {
  const rendered = await renderer.render(
    '## <a name="solution"></a>The solution\n\n## A [link](http://x) and ![alt](y.png) <b>bold</b>\n',
    "d.md",
  );
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "the-solution",
    "a-link-and-bold",
  ]);
  expect(rendered.html).toContain(
    '<h2 id="the-solution"><a name="solution"></a>The solution</h2>',
  );
});

test("an outline entry's text is the heading's text content, never its markup", async () => {
  const rendered = await renderer.render(
    '## A [link](http://x) and `code` and *bold* <b>b</b> ![alt](y.png)\n\n## <a name="x"></a>Foo\n',
    "d.md",
  );
  expect(rendered.toc.map((entry) => entry.text)).toEqual([
    "A link and code and bold b",
    "Foo",
  ]);
});

test("an underscore inside a word is text, not emphasis, so the outline keeps it", async () => {
  const rendered = await renderer.render("### PAGEDECK_SNAPSHOT_URL\n", "d.md");
  expect(rendered.toc).toEqual([
    { depth: 3, slug: "pagedeck-snapshot-url", text: "PAGEDECK_SNAPSHOT_URL" },
  ]);
  expect(rendered.html).toContain(
    '<h3 id="pagedeck-snapshot-url">PAGEDECK_SNAPSHOT_URL</h3>',
  );
});

test("an outline entry keeps every character a reader sees, and drops only the markers", async () => {
  const rendered = await renderer.render(
    "## `server_data_page.tsx`\n\n## An _emphasised_ word\n\n## A __strong__ word\n\n## snake_case and *star*\n\n## a * b\n\n## \\_escaped\\_\n\n## a `` ` `` tick\n",
    "d.md",
  );
  expect(rendered.toc.map(({ text, slug }) => [text, slug])).toEqual([
    ["server_data_page.tsx", "server-data-page-tsx"],
    ["An emphasised word", "an-emphasised-word"],
    ["A strong word", "a-strong-word"],
    ["snake_case and star", "snake-case-and-star"],
    ["a * b", "a-b"],
    ["_escaped_", "escaped"],
    ["a ` tick", "a-tick"],
  ]);
  expect(ids(rendered.html)).toEqual(rendered.toc.map((entry) => entry.slug));
});

test("the title is the heading's text content, never its markup", async () => {
  const rendered = await renderer.render(
    "# A [link](http://x) and `code` and *bold* <b>b</b> ![alt](y.png)\n",
    "d.md",
  );
  expect(rendered.title).toBe("A link and code and bold b");
});

test("a first level-1 heading with no text gives no title, and no later one takes over", async () => {
  for (const body of ["# ![x](y.png)\n\n# Real\n", "# <img src=x>\n\n# Real\n", "#\n\n# Real\n"]) {
    const rendered = await renderer.render(body, "d.md");
    expect(rendered.title).toBeUndefined();
    expect(rendered.html).toContain(">Real</h1>");
  }
});

test("the title keeps every character a reader sees, and drops only the markers", async () => {
  const titles = await Promise.all(
    [
      "# PAGEDECK_SNAPSHOT_URL\n",
      "# `server_data_page.tsx`\n",
      "# An _emphasised_ word\n",
      "# A __strong__ word\n",
      "# snake_case and *star*\n",
      "# a * b\n",
      "# \\_escaped\\_\n",
      "# a `` ` `` tick\n",
    ].map(async (body) => (await renderer.render(body, "d.md")).title),
  );
  expect(titles).toEqual([
    "PAGEDECK_SNAPSHOT_URL",
    "server_data_page.tsx",
    "An emphasised word",
    "A strong word",
    "snake_case and star",
    "a * b",
    "_escaped_",
    "a ` tick",
  ]);
});

test("a character reference in a heading is the character a reader sees, in the title, the outline and the slug", async () => {
  const rendered = await renderer.render(
    "# Tom &amp; Jerry\n\n## Tom &amp; Jerry\n\n## Caf&eacute;\n",
    "d.md",
  );
  expect(rendered.title).toBe("Tom & Jerry");
  expect(rendered.toc).toEqual([
    { depth: 2, slug: "tom-jerry", text: "Tom & Jerry" },
    { depth: 2, slug: "café", text: "Café" },
  ]);
  expect(ids(rendered.html)).toEqual(["tom-jerry", "café"]);
});

test("a named, a decimal and a hex reference each give the character", async () => {
  for (const reference of ["&copy;", "&#169;", "&#xA9;"]) {
    const rendered = await renderer.render(
      `# A ${reference} B\n\n## A ${reference} B\n`,
      "d.md",
    );
    expect(rendered.title, reference).toBe("A © B");
    expect(rendered.toc[0]?.text, reference).toBe("A © B");
  }
});

test("a character reference is decoded once, and a code span keeps it as written", async () => {
  const titles = await Promise.all(
    [
      "# `&amp;` in code\n",
      "# &amp;lt; stays text\n",
      "# a & b\n",
      "# \\&amp; escaped\n",
      "# &copy 2026 &bogus;\n",
    ].map(async (body) => (await renderer.render(body, "d.md")).title),
  );
  expect(titles).toEqual([
    "&amp; in code",
    "&lt; stays text",
    "a & b",
    "&amp; escaped",
    "&copy 2026 &bogus;",
  ]);
});

test("smartQuotes curls a typed quote and leaves a referenced one straight, as the heading renders them", async () => {
  const rendered = await curly.render('# &quot;A&quot; "B"\n\n## &quot;A&quot; "B"\n', "d.md");
  expect(rendered.title).toBe('"A" “B”');
  expect(rendered.toc[0]?.text).toBe('"A" “B”');
  expect(rendered.html).toContain(">&quot;A&quot; “B”</h2>");
});

test("the outline names exactly the headings the body anchors, in order", async () => {
  const rendered = await renderer.render(
    "# Title\n\n## Install\n\n### Install\n\n## Use it\n",
    "d.md",
  );
  expect(rendered.toc).toEqual([
    { depth: 2, slug: "install", text: "Install" },
    { depth: 3, slug: "install-1", text: "Install" },
    { depth: 2, slug: "use-it", text: "Use it" },
  ]);
  expect(ids(rendered.html)).toEqual(rendered.toc.map((entry) => entry.slug));
});

test("two renders of one document produce the same bytes and the same outline", async () => {
  const body = "## Install\n\n## Install\n\n## Notes\n";
  const first = await renderer.render(body, "d.md");
  const second = await renderer.render(body, "d.md");
  expect(second.html).toBe(first.html);
  expect(second.toc).toEqual(first.toc);
  expect(second.toc.map((entry) => entry.slug)).toEqual([
    "install",
    "install-1",
    "notes",
  ]);
});

const QUOTED = [
  "# The \"title\" isn't here",
  "",
  "## What's next",
  "",
  "She said \"it's fine\", and 'maybe' in the '90s.",
  "",
  "Code `it's \"raw\"` and <kbd>it's</kbd> and <span title=\"it's\">x</span>.",
  "",
  "![it's \"alt\"](a.png \"it's\") [a \"link\"](http://x \"it's\")",
  "",
  "\"*Quoted*\" and \\\"escaped\\\".",
  "",
  "```",
  "const s = \"it's\";",
  "```",
  "",
].join("\n");

const curly = await createMarkdownRenderer({ languages: ["ts"], smartQuotes: true });

test("without smartQuotes, a quoted document renders the bytes it rendered before the option existed", async () => {
  const expected = [
    '<h2 id="whats-next">What&#39;s next</h2>',
    "<p>She said &quot;it&#39;s fine&quot;, and &#39;maybe&#39; in the &#39;90s.</p>",
    '<p>Code <code>it&#39;s &quot;raw&quot;</code> and <kbd>it\'s</kbd> and <span title="it\'s">x</span>.</p>',
    '<p><img src="a.png" alt="it&#39;s &quot;alt&quot;" title="it&#39;s"> <a href="http://x" title="it&#39;s">a &quot;link&quot;</a></p>',
    "<p>&quot;<em>Quoted</em>&quot; and &quot;escaped&quot;.</p>",
    "<pre><code>const s = &quot;it&#39;s&quot;;",
    "</code></pre>",
  ].join("\n");
  const plain = await renderer.render(QUOTED, "d.md");
  expect(plain.html).toBe(expected);
  const off = await createMarkdownRenderer({ languages: ["ts"], smartQuotes: false });
  expect(await off.render(QUOTED, "d.md")).toEqual(plain);
});

test("smartQuotes curls the quotes and apostrophes in prose", async () => {
  const { html } = await curly.render(QUOTED, "d.md");
  expect(html).toContain("<p>She said “it’s fine”, and ‘maybe’ in the ’90s.</p>");
  expect(html).toContain("<p>“<em>Quoted</em>” and");
  expect(html).toContain('<a href="http://x" title="it&#39;s">a “link”</a>');
});

test("smartQuotes leaves code, raw HTML, attributes and escaped quotes straight", async () => {
  const { html } = await curly.render(QUOTED, "d.md");
  expect(html).toContain("<code>it&#39;s &quot;raw&quot;</code>");
  expect(html).toContain("<kbd>it's</kbd>");
  expect(html).toContain('<span title="it\'s">x</span>');
  expect(html).toContain('alt="it&#39;s &quot;alt&quot;" title="it&#39;s"');
  expect(html).toContain("and &quot;escaped&quot;.</p>");
  expect(html).toContain("<pre><code>const s = &quot;it&#39;s&quot;;");
});

test("smartQuotes changes no slug, and the outline and title read like the heading", async () => {
  const body = [
    '# The "title" isn\'t here',
    "## What's next",
    "## What's next",
    "## A `don't` flag",
    '## <a name="x"></a>It\'s here',
    "",
  ].join("\n\n");
  const straight = await renderer.render(body, "d.md");
  const curled = await curly.render(body, "d.md");
  expect(curled.toc.map((entry) => entry.slug)).toEqual(
    straight.toc.map((entry) => entry.slug),
  );
  expect(ids(curled.html)).toEqual(ids(straight.html));
  expect(curled.title).toBe("The “title” isn’t here");
  expect(curled.toc.map((entry) => entry.text)).toEqual([
    "What’s next",
    "What’s next",
    "A don't flag",
    "It’s here",
  ]);
  expect(curled.html).toContain('<h2 id="whats-next">What’s next</h2>');
  expect(curled.toc.map((entry) => entry.slug)).toEqual([
    "whats-next",
    "whats-next-1",
    "a-dont-flag",
    "its-here",
  ]);
  expect(curled.html).toContain("<code>don&#39;t</code>");
});

test("smartQuotes starts every block afresh", async () => {
  const { html } = await curly.render(
    'One "a"\n\n"Two"\n\n- "three"\n- x\n\n> "four"\n\n| "five" |\n| --- |\n| "six" |\n',
    "d.md",
  );
  expect(html).toContain("<p>One “a”</p>");
  expect(html).toContain("<p>“Two”</p>");
  expect(html).toContain("<li>“three”</li>");
  expect(html).toContain("<p>“four”</p>");
  expect(html).toContain("<th>“five”</th>");
  expect(html).toContain("<td>“six”</td>");
});

test("smartQuotes reads a quote after an image as following a word", async () => {
  const { html } = await curly.render('"![i](a.png)"\n\n![i](a.png)\'s\n', "d.md");
  expect(html).toContain('<p>“<img src="a.png" alt="i">”</p>');
  expect(html).toContain('<p><img src="a.png" alt="i">’s</p>');
});

test("smartQuotes opens a quote after an inline tag", async () => {
  const { html } = await curly.render('word<br>"quote"\n\nx<span>"q"</span>\n', "d.md");
  expect(html).toContain("<p>word<br>“quote”</p>");
  expect(html).toContain("<p>x<span>“q”</span></p>");
});

test("smartQuotes opens a quote after an escaped punctuation mark", async () => {
  const { html } = await curly.render('\\*"x"\n', "d.md");
  expect(html).toContain("<p>*“x”</p>");
});

test("smartQuotes leaves the text of an autolink and a bare URL as the href it shows", async () => {
  const { html } = await curly.render(
    "<http://x/it's> and https://x.com/a'b and www.x.com/it's\n",
    "d.md",
  );
  expect(html).toContain(">http://x/it&#39;s</a>");
  expect(html).toContain(">https://x.com/a&#39;b</a>");
  expect(html).toContain(">www.x.com/it&#39;s</a>");
});

test("smartQuotes curls the outline the way the heading renders, links and autolinks included", async () => {
  const { html, toc } = await curly.render(
    "## See [\"x\"](http://a/it's)\n\n## Auto <http://a/it's>\n",
    "d.md",
  );
  expect(toc.map((entry) => entry.text)).toEqual([
    "See “x”",
    "Auto http://a/it's",
  ]);
  expect(html).toContain(">“x”</a></h2>");
  expect(html).toContain(">http://a/it&#39;s</a></h2>");
});
