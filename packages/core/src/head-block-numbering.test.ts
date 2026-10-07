import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");

const NUMBERING = "CONTEXT.md";

const LIST_LEAD = "The blocks, in the order `headElements` writes them:";

const NUMBERING_FROM = NUMBERING.split(sep).join("/");

const MINIMUM_ITEMS = 5;
const MINIMUM_ANCHORS = 20;
const MINIMUM_REFERENCES = 8;
const MINIMUM_FILES = 100;

interface Declaration {
  readonly name: string;
  readonly at: number;
}

interface Item {
  readonly number: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly declaration: Declaration | undefined;
}

const DECLARES = /^\*\*.*?\*\*\s*\(`head:([a-z0-9-]+)`/;

function isBreak(line: string): boolean {
  return line.replace(/[/*\s]/g, "") === "";
}

function unmarked(line: string): string {
  const marker = /^\s*(\/\/|\/\*\*?|\*\/|\*)/.exec(line);
  const width = marker?.[1]?.length ?? 0;
  return marker === null
    ? line
    : line.slice(0, marker[0].length - width) +
        " ".repeat(width) +
        line.slice(marker[0].length);
}

function numberedItems(source: string): Item[] {
  const opens = source.indexOf(LIST_LEAD);
  const items: Item[] = [];
  if (opens === -1) return items;
  let at = opens;
  let open: { number: number; from: number; lines: string[] } | undefined;
  const close = (to: number): void => {
    if (open === undefined) return;
    const text = open.lines.join("\n");
    const name = DECLARES.exec(text.replace(/\s+/g, " "))?.[1];
    const at =
      name === undefined ? -1 : source.indexOf(`\`head:${name}\``, open.from);
    items.push({
      number: open.number,
      from: open.from,
      to,
      text,
      declaration:
        name !== undefined && at >= open.from && at < to
          ? { name, at }
          : undefined,
    });
    open = undefined;
  };
  for (const line of source.slice(opens).split("\n")) {
    const body = unmarked(line);
    const prose = body.trim();
    const opened = /^(\d+)\. (.*)$/.exec(prose);
    if (opened !== null) {
      close(at);
      open = { number: Number(opened[1]), from: at, lines: [opened[2] ?? ""] };
    } else if (open !== undefined) {
      if (prose !== "" && !/^\s{4}/.test(body)) {
        close(at);
        break;
      }
      open.lines.push(prose);
    }
    at += line.length + 1;
  }
  close(at);
  return items;
}

const NAMES_SOMETHING = /[.<@#]|[a-z][A-Z]/;

function anchors(items: readonly Item[]): Map<string, number> {
  const claims = new Map<string, number>();
  const claim = (spelling: string, by: number): void => {
    const held = claims.get(spelling);
    if (held === undefined) claims.set(spelling, by);
    else if (held !== by) claims.set(spelling, 0);
  };
  for (const item of items) {
    const flat = item.text.replace(/\s+/g, " ");
    for (const span of flat.matchAll(/`([^`\n]+)`/g)) {
      const spelling = span[1] ?? "";
      if (NAMES_SOMETHING.test(spelling)) claim(spelling, item.number);
    }
    for (const issue of flat.matchAll(/#\d+/g)) claim(issue[0], item.number);
    const lead = /\*\*(.*?)\*\*/.exec(flat);
    const named = (lead?.[1] ?? "")
      .replaceAll("`", "")
      .replace(/^(?:The|A|An)\s+/i, "")
      .replace(/[.,;:]+$/, "")
      .trim();
    if (named.split(" ").length > 1) claim(named, item.number);
  }
  for (const [spelling, by] of claims) {
    if (by === 0) continue;
    const wanted = spelling.toLowerCase();
    const written = items.some(
      (item) =>
        item.number !== by &&
        item.text.replace(/\s+/g, " ").toLowerCase().includes(wanted),
    );
    if (written) claims.set(spelling, 0);
  }
  return new Map([...claims].filter(([, by]) => by !== 0));
}

function commentsOf(source: string): string {
  const out = [...source];
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at++) if (out[at] !== "\n") out[at] = " ";
  };
  let at = 0;
  let codeStart = 0;
  while (at < source.length) {
    const here = source[at];
    const next = source[at + 1];
    if (here === "/" && next === "/") {
      blank(codeStart, at);
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
      codeStart = at;
      continue;
    }
    if (here === "/" && next === "*") {
      blank(codeStart, at);
      const end = source.indexOf("*/", at + 2);
      at = end === -1 ? source.length : end + 2;
      codeStart = at;
      continue;
    }
    if (here === '"' || here === "'" || here === "`") {
      at++;
      while (at < source.length) {
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source[at] === here) {
          at++;
          break;
        }
        at++;
      }
      continue;
    }
    at++;
  }
  blank(codeStart, source.length);
  return out.join("");
}

function proseOf(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return " ".repeat(line.length);
      }
      return inFence ? " ".repeat(line.length) : line;
    })
    .join("\n");
}

function walk(dir: string, wanted: (entry: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path, wanted));
      continue;
    }
    if (wanted(entry)) found.push(path);
  }
  return found;
}

function modules(): string[] {
  const found: string[] = [];
  for (const dir of readdirSync(join(REPO, "packages")).sort()) {
    const src = join(REPO, "packages", dir, "src");
    if (!existsSync(src)) continue;
    found.push(...walk(src, (entry) => /\.tsx?$/.test(entry)));
  }
  return found;
}

function documents(): string[] {
  const root = readdirSync(REPO)
    .sort()
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(REPO, entry));
  return [...root, ...walk(join(REPO, "docs"), (entry) => entry.endsWith(".md"))];
}

interface Reference {
  readonly from: string;
  readonly line: number;
  readonly said: number | undefined;
  readonly cites: string | undefined;
  readonly sentence: string;
  readonly quote: string;
  readonly named: readonly number[];
}

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

const REFERENCE = new RegExp(
  String.raw`\bblocks?\s+(\d+(?:(?:\s*,\s*|\s+and\s+|\s+or\s+)\d+)*)` +
    String.raw`|\b(${ORDINALS.join("|")})\s+block\b`,
  "gi",
);

const SENTENCE_END = /[.?!]\s+(?=[A-Z*`<#(\-\d])/g;

const NAMED = /`head:([a-z0-9-]+)`/g;

function referencesIn(
  file: string,
  prose: string,
  items: readonly Item[],
  vocabulary: ReadonlyMap<string, number>,
  declared: ReadonlyMap<string, number>,
): Reference[] {
  const from = relative(REPO, file).split(sep).join("/");
  const flat = prose.split("\n").map(unmarked).join("\n");
  const lines = flat.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const around = (
    index: number,
  ): Pick<Reference, "line" | "sentence" | "quote" | "named"> => {
    let line = starts.findIndex((start) => start > index) - 1;
    if (line < 0) line = lines.length - 1;
    let first = line;
    while (first > 0 && !isBreak(lines[first - 1] ?? "")) first--;
    let last = line;
    while (last < lines.length - 1 && !isBreak(lines[last + 1] ?? "")) last++;
    const opensAt = starts[first] ?? 0;
    const endsAt = (starts[last] ?? 0) + (lines[last]?.length ?? 0);
    const paragraph = flat.slice(opensAt, endsAt);
    let opens = 0;
    let span = paragraph;
    for (const stop of paragraph.matchAll(SENTENCE_END)) {
      const ends = stop.index + stop[0].length;
      if (opensAt + ends > index) {
        span = paragraph.slice(opens, ends);
        break;
      }
      opens = ends;
      span = paragraph.slice(opens);
    }
    const sentence = span.replace(/\s+/g, " ").trim();
    const quote = flat
      .slice(index, Math.min(index + 90, endsAt))
      .replace(/\s+/g, " ")
      .trim();
    const inside = items.find(
      (item) =>
        from === NUMBERING_FROM && index >= item.from && index < item.to,
    );
    const named = new Set<number>();
    for (const [spelling, item] of vocabulary) {
      if (item === inside?.number) continue;
      const written = spelling.replace(/\s+/g, " ").toLowerCase();
      if (sentence.toLowerCase().includes(written)) named.add(item);
    }
    return { line: line + 1, sentence, quote, named: [...named] };
  };
  const found: { at: number; reference: Reference }[] = [];
  for (const match of flat.matchAll(REFERENCE)) {
    const stated = match[1]?.match(/\d+/g) ?? [
      String(ORDINALS.indexOf((match[2] ?? "").toLowerCase()) + 1),
    ];
    for (const number of stated) {
      found.push({
        at: match.index,
        reference: {
          from,
          said: Number(number),
          cites: undefined,
          ...around(match.index),
        },
      });
    }
  }
  for (const match of flat.matchAll(NAMED)) {
    if (
      from === NUMBERING_FROM &&
      items.some(({ declaration }) => declaration?.at === match.index)
    )
      continue;
    const cites = match[1] ?? "";
    found.push({
      at: match.index,
      reference: {
        from,
        said: declared.get(cites),
        cites,
        ...around(match.index),
      },
    });
  }
  return found
    .sort((one, other) => one.at - other.at)
    .map(({ reference }) => reference);
}

const numbering = readFileSync(join(REPO, NUMBERING), "utf8");
const items = numberedItems(numbering);
const vocabulary = anchors(items);

const names = new Map<string, number>(
  items.flatMap(({ number, declaration }) =>
    declaration === undefined ? [] : [[declaration.name, number] as const],
  ),
);

function references(): Reference[] {
  return [
    ...modules().flatMap((file) =>
      referencesIn(
        file,
        commentsOf(readFileSync(file, "utf8")),
        items,
        vocabulary,
        names,
      ),
    ),
    ...documents().flatMap((file) =>
      referencesIn(
        file,
        proseOf(readFileSync(file, "utf8")),
        items,
        vocabulary,
        names,
      ),
    ),
  ];
}

function anchored({ named }: Reference): number | undefined {
  return named.length === 1 ? named[0] : undefined;
}

test("every block reference its own sentence places names the block it means", () => {
  const walked = modules().length + documents().length;
  expect(
    walked,
    `Head block numbering: the walk opened ${String(walked)} files, fewer than ${String(MINIMUM_FILES)} modules and Markdown files — the walk has stopped reaching the repo; fix it rather than lowering the floor`,
  ).toBeGreaterThanOrEqual(MINIMUM_FILES);
  const found = references();

  expect(
    items.map(({ number }) => number),
    `Head block numbering: the numbered list of the \`<head>\`'s blocks (${NUMBERING_FROM}) no longer reads as ${String(MINIMUM_ITEMS)} or more items numbered from 1 without a gap — restore the list, or move this reader to wherever the order went, before reading a green run below as evidence about anything`,
  ).toEqual(items.map((_, index) => index + 1));
  expect(
    items.length,
    `Head block numbering: the reader found fewer than ${String(MINIMUM_ITEMS)} numbered items in the \`<head>\`'s block list (${NUMBERING_FROM}) — it has stopped seeing the list, so fix it rather than lowering the floor`,
  ).toBeGreaterThanOrEqual(MINIMUM_ITEMS);
  expect(
    items
      .filter(({ declaration }) => declaration === undefined)
      .map(({ number }) => number),
    `Head block numbering: ${String(items.filter(({ declaration }) => declaration === undefined).length)} item(s) of the \`<head>\`'s block list (${NUMBERING_FROM}) declare no name — give each one a \`(\`head:<name>\`)\` immediately after its bolded lead, since a reference cites the name and a block with none can only be cited by its number`,
  ).toEqual([]);
  expect(
    [...names].map(([, number]) => number),
    `Head block numbering: two items of the \`<head>\`'s block list (${NUMBERING_FROM}) declare the same name — a name two blocks answer to places a reference on neither, so rename one of them`,
  ).toEqual(items.map(({ number }) => number));
  expect(
    vocabulary.size,
    `Head block numbering: the list yields fewer than ${String(MINIMUM_ANCHORS)} spellings that name exactly one of its items — the anchor reader has broken, and with no anchors every reference below is "unplaced" and nothing is checked`,
  ).toBeGreaterThanOrEqual(MINIMUM_ANCHORS);
  expect(
    found.filter(({ from }) => from.endsWith(".md")).length,
    `Head block numbering: the walk found fewer than ${String(MINIMUM_REFERENCES)} references to a numbered block across the repo's Markdown — either the walk has stopped reaching files or the reference pattern has stopped matching them; fix the reader rather than lowering the floor`,
  ).toBeGreaterThanOrEqual(MINIMUM_REFERENCES);

  const declarations = items.flatMap(({ declaration }) =>
    declaration === undefined
      ? []
      : [numbering.slice(0, declaration.at).split("\n").length],
  );
  expect(
    found.filter(
      ({ from, line }) => from === NUMBERING_FROM && declarations.includes(line),
    ),
    `Head block numbering: the walk is reading the name declarations in the \`<head>\`'s block list (${NUMBERING_FROM}) as references to the blocks they declare — a declaration is the thing a reference points at, so counting it inflates every figure this file reports by one per block; fix the reader that records where each declaration is written, \`DECLARES\` and \`numberedItems\` here, or put the item's own \`head:\` span back in the parenthesis immediately after its bolded lead where that reader looks for it`,
  ).toEqual([]);

  const unknown = found.filter(
    ({ cites, said }) => cites !== undefined && said === undefined,
  );
  expect(unknown, nameReport(unknown)).toEqual([]);

  const drifted = found.filter((reference) => {
    const on = anchored(reference);
    return (
      on !== undefined && reference.said !== undefined && on !== reference.said
    );
  });
  expect(drifted, driftReport(drifted)).toEqual([]);

  const adrift = found.filter(
    (reference) =>
      reference.cites === undefined && anchored(reference) === undefined,
  );
  expect(adrift, reachReport(adrift)).toEqual([]);
});

function driftReport(drifted: readonly Reference[]): string {
  const count = drifted.length;
  const lines = drifted.map(
    ({ from, line, said, cites, named, sentence }) =>
      `${from}:${String(line)}: ${cites === undefined ? `says block ${String(said)}` : `cites \`head:${cites}\``}, and its own sentence describes block ${String(named[0])} — "${sentence.slice(0, 120)}"`,
  );
  return `Head block numbering: ${String(count)} reference${count === 1 ? "" : "s"} to the \`<head>\`'s order name${count === 1 ? "s" : ""} a block its own sentence does not describe — correct the reference to the name the \`<head>\`'s block list (${NUMBERING_FROM}) gives the block that sentence describes, or correct the sentence if the reference is the right one:\n  ${lines.join("\n  ")}`;
}

function nameReport(unknown: readonly Reference[]): string {
  const count = unknown.length;
  const lines = unknown.map(
    ({ from, line, cites, quote }) =>
      `${from}:${String(line)}: cites \`head:${String(cites)}\` — "${quote}"`,
  );
  return `Head block numbering: ${String(count)} reference${count === 1 ? "" : "s"} to the \`<head>\`'s order cite${count === 1 ? "s" : ""} a name no block in the \`<head>\`'s block list (${NUMBERING_FROM}) declares — spell it as one of the names that list does declare (${[...names.keys()].map((name) => `\`head:${name}\``).join(", ")}), or declare it there if the reference is right and the list is what moved:\n  ${lines.join("\n  ")}`;
}

function reachReport(adrift: readonly Reference[]): string {
  const count = adrift.length;
  const lines = adrift.map(
    ({ from, line, said, named, quote }) =>
      `${from}:${String(line)}: says block ${String(said)}, and its sentence names ${named.length === 0 ? "no block" : `blocks ${named.map(String).sort().join(" and ")}`} — "${quote}"`,
  );
  return `Head block numbering: ${String(count)} reference${count === 1 ? "" : "s"} to the \`<head>\`'s order state${count === 1 ? "s" : ""} a number ${count === 1 ? "its" : "their"} own sentence cannot place — cite the block by the name the \`<head>\`'s block list (${NUMBERING_FROM}) declares for it (${[...names.keys()].map((name) => `\`head:${name}\``).join(", ")}), which places the reference whatever the sentence around it happens to say:\n  ${lines.join("\n  ")}`;
}

test("the walk reads a block written as a digit, as a word and as a name", () => {
  const sample = [
    "Written into block 4, which is where a preload hint goes.",
    "The fourth block is where it goes.",
    "It goes into the `head:stylesheets` block, and not beside it.",
    "Nothing at all goes into the `head:nowhere` block.",
  ].join("\n\n");

  expect(
    referencesIn(join(REPO, "sample.md"), sample, items, vocabulary, names).map(
      ({ said, cites }) => [said, cites],
    ),
  ).toEqual([
    [4, undefined],
    [4, undefined],
    [6, "stylesheets"],
    [undefined, "nowhere"],
  ]);
});

test("the comment reader finds a reference in a comment and none in code", () => {
  const sample = [
    'const quoted = "the `head:charset` block";',
    "// It goes into the `head:stylesheets` block.",
    "/** It goes into the `head:json-ld` block. */",
  ].join("\n");

  expect(
    referencesIn(
      join(REPO, "sample.ts"),
      commentsOf(sample),
      items,
      vocabulary,
      names,
    ).map(({ cites, line }) => [cites, line]),
  ).toEqual([
    ["stylesheets", 2],
    ["json-ld", 3],
  ]);
});
