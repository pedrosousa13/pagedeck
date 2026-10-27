import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { unescapedHtml } from "@pagedeck/core/tree";
import { createMarkdownRenderer, parseFrontmatter } from "@pagedeck/markdown-loader";
import { guides, PACKAGE } from "./pages.test-support.js";
import { docsRenderer } from "./render.test-support.js";

test("no docs page loses a byte to the reserved-name strip", async () => {
  const render = await docsRenderer();
  const losses: string[] = [];
  for (const file of guides()) {
    const { body } = parseFrontmatter(readFileSync(join(PACKAGE, file), "utf8"), file);
    const { html } = await render.render(body, file);
    const stripped = unescapedHtml(html).dangerouslySetInnerHTML.__html;
    if (stripped === html) continue;
    let start = 0;
    while (html[start] === stripped[start]) start += 1;
    let end = 0;
    while (
      end < stripped.length - start &&
      html[html.length - 1 - end] === stripped[stripped.length - 1 - end]
    ) {
      end += 1;
    }
    losses.push(`${file}: the strip removes ${JSON.stringify(html.slice(start, html.length - end))}`);
  }

  expect(losses).toEqual([]);
});

test("a heading spelling a framework-reserved name still anchors after the strip", async () => {
  // Checked here, not in `@pagedeck/markdown-loader`, which must not depend on
  // `@pagedeck/core`.
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    "## data-pagedeck-slot\n\n## Data Pagedeck Props\n\n## data-pagedeck\n\n## data-pagedeck\n",
    "d.md",
  );
  const stripped = unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html;

  expect(
    [...stripped.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]),
  ).toEqual(rendered.toc.map((entry) => entry.slug));
  // The strip also removes reserved names from prose, so the heading's own text
  // goes; its anchor still lands.
  expect(stripped).toContain('<h2 id="slot"></h2>');
});

test("a heading spelling a reserved name after a non-ASCII letter still anchors", async () => {
  // A non-ASCII letter is the one character `slugify` admits that core's ASCII
  // name boundary cuts at, putting a reserved name mid-slug.
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    "## エdata-pagedeck-slot\n\n## 属性data-pagedeck-props\n\n## édata-pagedeck-mode\n\n## ページdata-pagedeck-template\n\n## エdata-pagedeck-slotédata-pagedeck-props\n",
    "d.md",
  );
  const stripped = unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html;

  expect(
    [...stripped.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]),
  ).toEqual(rendered.toc.map((entry) => entry.slug));
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "エslot",
    "属性props",
    "émode",
    "ページtemplate",
    // Two in one slug, so a strip that stopped after one removal would fail here.
    "エslotéprops",
  ]);
});

