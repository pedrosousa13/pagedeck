import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RESERVED_IDS, unescapedHtml } from "@pagedeck/core/tree";
import { createMarkdownRenderer, parseFrontmatter } from "@pagedeck/markdown-loader";
import { guides, PACKAGE } from "./pages.test-support.js";
import { docsRenderer } from "./render.test-support.js";

test("no docs page has a reserved name to neutralize", async () => {
  const render = await docsRenderer();
  const neutralized: string[] = [];
  for (const file of guides()) {
    const { body } = parseFrontmatter(readFileSync(join(PACKAGE, file), "utf8"), file);
    const { html } = await render.render(body, file);
    const after = unescapedHtml(html).dangerouslySetInnerHTML.__html;
    if (after === html) continue;
    let start = 0;
    while (html[start] === after[start]) start += 1;
    let end = 0;
    while (
      end < html.length - start &&
      html[html.length - 1 - end] === after[after.length - 1 - end]
    ) {
      end += 1;
    }
    neutralized.push(
      `${file}: neutralizing turns ${JSON.stringify(html.slice(start, html.length - end))}` +
        ` into ${JSON.stringify(after.slice(start, after.length - end))}`,
    );
  }

  expect(neutralized).toEqual([]);
});

test("a heading spelling a framework-reserved name still anchors after neutralizing", async () => {
  // Checked here, not in `@pagedeck/markdown-loader`, which must not depend on
  // `@pagedeck/core`.
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    "## data-pagedeck-slot\n\n## Data Pagedeck Props\n\n## data-pagedeck\n\n## data-pagedeck\n",
    "d.md",
  );
  const neutralizedHtml = unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html;

  expect(
    [...neutralizedHtml.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]),
  ).toEqual(rendered.toc.map((entry) => entry.slug));
  expect(neutralizedHtml).toContain('<h2 id="slot">data-x-pagedeck-slot</h2>');
});

test("a heading spelling an id the framework looks up still anchors after neutralizing", async () => {
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    RESERVED_IDS.map((id) => `## ${id}\n`).join("\n"),
    "d.md",
  );

  expect(rendered.toc.map((entry) => entry.slug)).toEqual(RESERVED_IDS.map((id) => `${id}-1`));
  expect(unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html).toBe(rendered.html);
});

test("a heading spelling a reserved name after a non-ASCII letter still anchors", async () => {
  // A non-ASCII letter is the one character `slugify` admits that core's ASCII
  // name boundary cuts at, putting a reserved name mid-slug.
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    "## エdata-pagedeck-slot\n\n## 属性data-pagedeck-props\n\n## édata-pagedeck-mode\n\n## ページdata-pagedeck-template\n\n## エdata-pagedeck-slotédata-pagedeck-props\n",
    "d.md",
  );
  const neutralizedHtml = unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html;

  expect(
    [...neutralizedHtml.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]),
  ).toEqual(rendered.toc.map((entry) => entry.slug));
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "エslot",
    "属性props",
    "émode",
    "ページtemplate",
    // Two in one slug, so a pass that caught only one would fail here.
    "エslotéprops",
  ]);
});

