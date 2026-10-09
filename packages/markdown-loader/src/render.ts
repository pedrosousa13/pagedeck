// Highlights at sync time, with colours inline, so a content page ships no script and no
// stylesheet (spec §8). The HTML is trusted like rich text: there is no sanitizer.
import { decodeHTMLStrict } from "entities";
import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import { createHighlighter } from "shiki";
import type { BundledLanguage, BundledTheme, Highlighter } from "shiki";

export interface RenderedMarkdown {
  /** Without the level-1 heading that became `title`. */
  readonly html: string;
  readonly title?: string;
  /** Data, not a `<nav>`; the heading that became `title` is not in it. */
  readonly toc: readonly TocEntry[];
}

export interface TocEntry {
  /** The heading's level: 1 for `#`, 2 for `##`, and so on. */
  readonly depth: number;
  /**
   * What a reader sees in the heading: markup gives only its text, an image nothing (#542).
   * Text, not HTML. Curled like the heading under `smartQuotes`.
   */
  readonly text: string;
  /** The `id` of the heading element this render emitted for it. */
  readonly slug: string;
}

export interface MarkdownRenderer {
  render(body: string, file: string): Promise<RenderedMarkdown>;
}

export interface MarkdownRendererOptions {
  /** Declared, not discovered: each grammar costs a load, and an undeclared fence is refused. */
  readonly languages: readonly BundledLanguage[];
  /** Defaults to `github-light`; the README has the rule a `{ light, dark }` pair needs. */
  readonly theme?:
    | BundledTheme
    | { readonly light: BundledTheme; readonly dark: BundledTheme };
  /**
   * Curl straight quotes in prose (#541); off unless named.
   * Quotes only, never in code, raw HTML, attributes or URLs, and slugs are unaffected.
   */
  readonly smartQuotes?: boolean;
}

/**
 * A character a quote opens after: a space, an opening bracket or quote, or a
 * dash. After anything else, and so after a letter, a quote closes.
 */
const OPENS_AFTER = /[\s([{\u2018\u201c\u2013\u2014-]/u;

// The curled character carries forward: after `’` a quote closes, after `‘` it opens.
function curlQuotes(text: string, before: string): string {
  let previous = before;
  let curled = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const opens = previous === "" || OPENS_AFTER.test(previous);
    let written = character;
    if (character === '"') written = opens ? "\u201c" : "\u201d";
    if (character === "'") {
      written = opens && !/\d/.test(text.charAt(index + 1)) ? "\u2018" : "\u2019";
    }
    curled += written;
    previous = written;
  }
  return curled;
}

const AFTER_WORD = "a";

// Walked per block, so the character before each run carries through emphasis and links.
// Code, escapes, raw tags, images and URLs stay straight.
function curlInline(tokens: readonly Token[], before: string): string {
  let previous = before;
  for (const token of tokens) {
    if (token.type === "text") {
      const text = token as Tokens.Text;
      if (text.tokens !== undefined) {
        previous = curlInline(text.tokens, previous);
        continue;
      }
      if (text.escaped !== true) text.text = curlQuotes(text.text, previous);
      previous = text.text.slice(-1) || previous;
    } else if (token.type === "codespan") {
      previous = (token as Tokens.Codespan).text.slice(-1) || previous;
    } else if (token.type === "escape") {
      const escaped = (token as Tokens.Escape).text;
      previous = /[)\]}]/.test(escaped) ? escaped : " ";
    } else if (token.type === "br" || token.type === "html") {
      previous = "\n";
    } else if (token.type === "image") {
      previous = AFTER_WORD;
    } else if (token.type === "link" && !token.raw.startsWith("[")) {
      previous = AFTER_WORD;
    } else {
      const children = (token as Tokens.Generic).tokens;
      if (children !== undefined) previous = curlInline(children, previous);
    }
  }
  return previous;
}

function curlBlock(token: Token): void {
  if (token.type === "paragraph" || token.type === "heading") {
    curlInline((token as Tokens.Paragraph | Tokens.Heading).tokens, "");
  } else if (token.type === "text") {
    curlInline((token as Tokens.Text).tokens ?? [], "");
  } else if (token.type === "table") {
    const table = token as Tokens.Table;
    for (const cell of [...table.header, ...table.rows.flat()]) curlInline(cell.tokens, "");
  }
}

// `walkTokens` may be async and the renderer may not, so highlighting happens in the walk.
interface HighlightedCode extends Tokens.Code {
  fwHighlighted?: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escaped here: the renderer is bypassed for code tokens. One pass, so `&` is not escaped
// twice.
function plainCode(code: string): string {
  const escaped = code.replace(/[&<>"']/g, (character) =>
    ESCAPES[character] === undefined ? character : ESCAPES[character],
  );
  return `<pre><code>${escaped}\n</code></pre>`;
}

function unknownLanguageReport(file: string, unknown: Set<string>): string {
  const languages = [...unknown].sort();
  const subject =
    languages.length === 1
      ? "1 code language is not loaded, so its fences cannot be highlighted"
      : `${String(languages.length)} code languages are not loaded, so their fences cannot be highlighted`;
  return `Markdown "${file}": ${subject} — add each to the loader's languages, or drop the language from the fence:\n${languages
    .map((language) => `  ${language}`)
    .join("\n")}`;
}

// Raw HTML and images give nothing, a link its text. `curled` picks a text token's `text`
// over its straight `raw`. Strict, because marked shows a reference with no `;` literally
// (#101).
function textContent(tokens: readonly Token[], curled: boolean): string {
  let text = "";
  for (const token of tokens) {
    if (token.type === "html" || token.type === "image") continue;
    const children = (token as Tokens.Generic).tokens;
    if (token.type === "text" && children === undefined) {
      text += decodeHTMLStrict(curled ? (token as Tokens.Text).text : token.raw);
    } else if (token.type === "codespan" || token.type === "escape") {
      text += (token as Tokens.Codespan | Tokens.Escape).text;
    } else if (children !== undefined) text += textContent(children, curled);
  }
  return text.trim();
}

// A whitelist of Unicode letters and digits, so an `id` holds no quote, bracket or `&` and
// needs no escaper (#327). An apostrophe is dropped, as GitHub and Astro do (#542).
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

const FALLBACK_SLUG = "section";

// `(?<![-\w])` is core's ASCII name boundary (`NAME_CHARACTER`), so a reserved name after a
// non-ASCII letter is caught, as `stripReservedNames` would strip it.
const RESERVED = /(?<![-\w])(?:(?:data-)?fw(?:-|$))+/g;

// `stripReservedNames` deletes `data-fw-*` names from content, `id`s included, so a heading
// spelling one would lose its anchor; `fw-` ids are the framework's. One pass is a fixed point.
function unreserved(slug: string): string {
  return slug.replace(RESERVED, "");
}

// Asks whether a slug is free, not how often its text was seen: "Options 1" owns `options-1`.
function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  for (let suffix = 1; taken.has(slug); suffix += 1) {
    slug = `${base}-${String(suffix)}`;
  }
  taken.add(slug);
  return slug;
}

// Marked on the token, not matched on text, so of two identical headings the right one goes.
interface TitleHeading extends Tokens.Heading {
  fwTitle?: true;
}

export async function createMarkdownRenderer(
  options: MarkdownRendererOptions,
): Promise<MarkdownRenderer> {
  const theme = options.theme ?? "github-light";
  const highlighter: Highlighter = await createHighlighter({
    themes: typeof theme === "string" ? [theme] : [theme.light, theme.dark],
    langs: [...options.languages],
  });
  const colours =
    typeof theme === "string"
      ? { theme }
      : { themes: theme, defaultColor: "light" as const };
  const loaded = new Set(highlighter.getLoadedLanguages());
  const smartQuotes = options.smartQuotes === true;

  return {
    async render(body, file) {
      // Per render: a shared set would report a language on every later file.
      const unknown = new Set<string>();
      let titleSeen = false;
      let title: string | undefined;
      const toc: TocEntry[] = [];
      const taken = new Set<string>();

      const marked = new Marked({
        async: true,
        walkTokens: (token: Token) => {
          if (smartQuotes) curlBlock(token);
          if (token.type === "heading") {
            // Narrowing on `type` alone leaves the `Generic` member's fields optional.
            const heading = token as TitleHeading;
            if (heading.depth === 1 && !titleSeen) {
              titleSeen = true;
              title = textContent(heading.tokens, smartQuotes) || undefined;
              heading.fwTitle = true;
            }
          }
          if (token.type !== "code") return;
          const code = token as HighlightedCode;
          const language = code.lang?.trim() ?? "";
          if (language === "") {
            code.fwHighlighted = plainCode(code.text);
            return;
          }
          if (!loaded.has(language)) {
            unknown.add(language);
            // Left unhighlighted so the render completes; the throw comes after the whole walk.
            code.fwHighlighted = plainCode(code.text);
            return;
          }
          code.fwHighlighted = highlighter.codeToHtml(code.text, {
            lang: language,
            ...colours,
          });
        },
        renderer: {
          heading(this: { parser: { parseInline(tokens: Token[]): string } }, token: Tokens.Heading): string {
            if ((token as TitleHeading).fwTitle === true) return "";
            const depth = String(token.depth);
            const slug = uniqueSlug(
              unreserved(slugify(textContent(token.tokens, false))) || FALLBACK_SLUG,
              taken,
            );
            toc.push({
              depth: token.depth,
              text: textContent(token.tokens, smartQuotes),
              slug,
            });
            return `<h${depth} id="${slug}">${this.parser.parseInline(token.tokens)}</h${depth}>\n`;
          },
          code(token: Tokens.Code): string {
            // Always set by the walk; the fallback keeps a parser change from printing "undefined".
            return (token as HighlightedCode).fwHighlighted ?? plainCode(token.text);
          },
        },
      });

      const html = await marked.parse(body);
      if (unknown.size > 0) throw new Error(unknownLanguageReport(file, unknown));
      return title === undefined ? { html, toc } : { html, title, toc };
    },
  };
}
