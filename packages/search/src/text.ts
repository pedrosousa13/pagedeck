// A scan, not a parser: the input is this build's own renderer output. An unbalanced content
// blob costs at most the text of elements it left open, never an exception.

import { SEARCH_ATTRIBUTE } from "@pagedeck/core";

export interface Heading {
  readonly text: string;
}

export interface Section {
  readonly heading: Heading | null;
  readonly text: string;
}

export interface ExtractedText {
  readonly sections: readonly Section[];
}

const DROPPED = new Set(["script", "style", "template"]);

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const HEADING = /^h[1-6]$/;

// Only the references this framework's renderers write; a fuller table is a parser's job.
const REFERENCES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#x27;", "'"],
  ["&#39;", "'"],
]);

const REFERENCE = /&(?:amp|lt|gt|quot|#x27|#39);/g;

// One pass: `&amp;lt;` is the text `&lt;`.
function decode(text: string): string {
  return text.replace(REFERENCE, (found) => REFERENCES.get(found) ?? found);
}

interface Open {
  readonly name: string;
  readonly dropped: boolean;
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(
    /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g,
  )) {
    attributes.set(
      (match[1] ?? "").toLowerCase(),
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attributes;
}

// `hidden` hides whatever its value; `aria-hidden` only as `"true"`. Inline styles are not read.
function isHidden(attributes: Map<string, string>): boolean {
  if (attributes.has("hidden")) return true;
  return attributes.get("aria-hidden") === "true";
}

function isIgnored(attributes: Map<string, string>): boolean {
  return attributes.get(SEARCH_ATTRIBUTE) === "ignore";
}

function collapse(runs: readonly string[]): string {
  return runs.join(" ").replace(/\s+/g, " ").trim();
}

// Runs are joined with a space: an element boundary is a word boundary.
export function extractText(html: string): ExtractedText {
  const sections: Section[] = [];
  const open: Open[] = [];
  let runs: string[] = [];
  let heading: Heading | null = null;
  let capturing: string[] | undefined;

  const closeSection = (): void => {
    const text = collapse(runs);
    if (heading !== null || text !== "") sections.push({ heading, text });
    runs = [];
  };
  const dropped = (): boolean => open.some((element) => element.dropped);

  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      if (!dropped()) (capturing ?? runs).push(decode(html.slice(index)));
      break;
    }
    if (next > index && !dropped()) {
      (capturing ?? runs).push(decode(html.slice(index, next)));
    }

    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      const end = html.indexOf(">", next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = tagEnd(html, next);
    const tag = html.slice(next + 1, end);
    index = end + 1;
    if (tag === "") continue;

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim().toLowerCase();
      // A reverse walk, not `findLastIndex`, which the workspace's ES2022 `lib` lacks.
      let depth = open.length - 1;
      while (depth >= 0 && (open[depth] as Open).name !== name) depth -= 1;
      if (depth === -1) continue;
      open.length = depth;
      if (capturing !== undefined && HEADING.test(name)) {
        closeSection();
        heading = { text: collapse(capturing) };
        capturing = undefined;
      }
      continue;
    }

    const name = /^[^\s/>]*/.exec(tag)?.[0]?.toLowerCase() ?? "";
    if (name === "") continue;
    const attributes = attributesOf(tag.slice(name.length));
    const hide =
      DROPPED.has(name) ||
      isHidden(attributes) ||
      isIgnored(attributes) ||
      dropped();
    if (VOID.has(name) || tag.endsWith("/")) continue;
    open.push({ name, dropped: hide });

    if (HEADING.test(name) && !hide && capturing === undefined) capturing = [];
  }

  closeSection();
  return { sections };
}

function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index] as string;
    if (quote !== "") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return html.length;
}
