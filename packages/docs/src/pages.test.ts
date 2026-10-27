import { readFileSync } from "node:fs";
import { Marked } from "marked";
import { expect, test } from "vitest";
import { parseFrontmatter } from "@pagedeck/markdown-loader";
import { guides, navPages, published, sourceOf } from "./pages.test-support.js";
import { docsRenderer, LANGUAGES } from "./render.test-support.js";

// Keeps a meta description within the length a search result shows whole (#565).
const DESCRIPTION_LIMIT = 150;

const packed = (): string[] => [...guides(), ...published()];

const read = (page: string): string => readFileSync(sourceOf(page), "utf8");

function descriptionFault(value: unknown): string | undefined {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    return `missing — give the page a "description" in its frontmatter: one sentence saying what the page covers, ${String(DESCRIPTION_LIMIT)} characters at most, which is its meta description`;
  }
  if (Array.isArray(value)) {
    return "is a list, not one line of text — write the description as a single sentence after the colon, with no brackets";
  }
  if (typeof value !== "string") {
    return `is a ${typeof value}, not a string — write the description as a single sentence after the colon`;
  }
  const length = value.trim().length;
  return length > DESCRIPTION_LIMIT
    ? `${String(length)} characters, over the ${String(DESCRIPTION_LIMIT)} a meta description is kept to — shorten it to ${String(DESCRIPTION_LIMIT)} or fewer`
    : undefined;
}

test("the description check refuses a missing, blank, list or overlong description, with the fix", () => {
  expect(descriptionFault(undefined)).toMatch(/^missing — give the page a "description"/);
  expect(descriptionFault("  ")).toMatch(/^missing — /);
  expect(descriptionFault(["a", "b"])).toMatch(/^is a list, not one line of text — /);
  expect(descriptionFault("x".repeat(151))).toMatch(/^151 characters, over the 150 .* shorten it to 150 or fewer$/);
  expect(descriptionFault("x".repeat(150))).toBeUndefined();
});

test("every page carries one description of its own, 150 characters at most", () => {
  const faults = packed().flatMap((page) => {
    const fault = descriptionFault(parseFrontmatter(read(page), page).frontmatter["description"]);
    return fault === undefined ? [] : [`${page}: "description" ${fault}`];
  });
  expect(faults).toEqual([]);
});

test("every fence language on a packed page is one the docs highlight", () => {
  const known: readonly string[] = LANGUAGES;
  const faults: string[] = [];
  for (const page of packed()) {
    const marked = new Marked();
    marked.walkTokens(marked.lexer(parseFrontmatter(read(page), page).body), (token) => {
      const lang = token.type === "code" ? (token as { lang?: string }).lang?.split(/\s/)[0] : undefined;
      if (lang !== undefined && lang !== "" && !known.includes(lang)) faults.push(`${page}: \`\`\`${lang}`);
    });
  }
  expect(
    faults,
    "add the language to LANGUAGES in packages/docs/src/render.test-support.ts and to the languages deck-cool's sites/pagedeck/pagedeck.config.ts passes defineDocs, or write the fence in one already there",
  ).toEqual([]);
});

test("every in-page link a page writes resolves to an anchor it holds", async () => {
  const render = await docsRenderer();
  const faults: string[] = [];
  for (const page of navPages()) {
    const { html } = await render.render(parseFrontmatter(read(page), page).body, page);
    const ids = new Set([...html.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]));
    for (const [, fragment] of html.matchAll(/ href="#([^"]*)"/g)) {
      if (!ids.has(fragment)) faults.push(`${page}: #${fragment as string} — no heading or element has that id; link a heading the page has`);
    }
  }
  expect(faults).toEqual([]);
});
