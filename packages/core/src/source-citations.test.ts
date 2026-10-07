import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");

const MINIMUM_CATALOGUE_CITATIONS = 60;
const MINIMUM_DOCUMENT_CITATIONS = 80;

const MINIMUM_MODULES = 100;

const CATALOGUE = join("docs", "error-messages.md");

interface Citation {
  readonly from: string;
  readonly line: number;
  readonly name: string;
  readonly path: string;
}

const SOURCE_PATH = /^packages\/[\w.-]+\/[\w./-]+\.(?:tsx?|jsx?)$/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// `, and` is deliberately not a separator: it usually joins clauses. The parenthesised
// form tolerates trailing content such as `(`path`, #324)`.
const CITATION =
  /(`[^`\n]+`(?:(?:,|\s+and)\s+`[^`\n]+`)*)\s*(?:\(`([^`\n]+)`[^)\n]*\)|(?:in|at|from)\s+`([^`\n]+)`)/g;

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

function proseOf(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
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

function citationsIn(file: string, prose: string): Citation[] {
  const from = relative(REPO, file).split(sep).join("/");
  const found: Citation[] = [];
  for (const match of prose.matchAll(CITATION)) {
    const path = (match[2] ?? match[3] ?? "").replace(/:\d+(?::\d+)?$/, "");
    if (!SOURCE_PATH.test(path)) continue;
    const line = prose.slice(0, match.index).split("\n").length;
    for (const spelt of (match[1] ?? "").split(/(?:,|\s+and)\s+/)) {
      const name = spelt
        .replaceAll("`", "")
        .trim()
        .replace(/\(\)$/, "")
        .replace(/<.*>$/, "");
      if (!IDENTIFIER.test(name)) continue;
      found.push({ from, line, name, path });
    }
  }
  return found;
}

function binds(source: string, name: string): boolean {
  const declaration = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|type|interface|enum)\\s+${name}\\b`,
  );
  if (declaration.test(source)) return true;
  for (const clause of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const specifier of (clause[1] ?? "").split(",")) {
      const parts = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if ((parts[1] ?? parts[0] ?? "").trim() === name) return true;
    }
  }
  return false;
}

function documents(): string[] {
  const root = readdirSync(REPO)
    .sort()
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(REPO, entry));
  return [...root, ...walk(join(REPO, "docs"), (e) => e.endsWith(".md"))];
}

function modules(): string[] {
  const found: string[] = [];
  for (const dir of readdirSync(join(REPO, "packages")).sort()) {
    const src = join(REPO, "packages", dir, "src");
    if (!existsSync(src)) continue;
    found.push(...walk(src, (e) => /\.tsx?$/.test(e)));
  }
  return found;
}

const CATALOGUE_FROM = CATALOGUE.split(sep).join("/");

test("every citation names a file that holds the name", () => {
  const fromDocuments = documents().flatMap((file) =>
    citationsIn(file, proseOf(readFileSync(file, "utf8"))),
  );
  const walked = modules();
  const fromComments = walked.flatMap((file) =>
    citationsIn(file, commentsOf(readFileSync(file, "utf8"))),
  );

  expect(
    fromDocuments.filter(({ from }) => from === CATALOGUE_FROM).length,
    `Citations: the walk found fewer than ${String(MINIMUM_CATALOGUE_CITATIONS)} citations in ${CATALOGUE}, which is the document #426 is about — the Markdown reader has stopped matching the citation forms, so fix it before reading a green run below as evidence about the catalogue`,
  ).toBeGreaterThanOrEqual(MINIMUM_CATALOGUE_CITATIONS);
  expect(
    fromDocuments.length,
    `Citations: the walk found fewer than ${String(MINIMUM_DOCUMENT_CITATIONS)} citations across the repo's Markdown — either the document walk has stopped reaching files or the citation grammar has stopped matching them; fix the reader rather than lowering the floor`,
  ).toBeGreaterThanOrEqual(MINIMUM_DOCUMENT_CITATIONS);
  expect(
    walked.length,
    `Citations: the walk reached fewer than ${String(MINIMUM_MODULES)} modules under the packages' \`src\` trees, whose comments held three of #344's seven defects — the module walk has broken; fix it rather than lowering the floor`,
  ).toBeGreaterThanOrEqual(MINIMUM_MODULES);

  const faults = [...fromDocuments, ...fromComments]
    .filter(({ name, path }) => {
      const cited = join(REPO, path);
      return !existsSync(cited) || !binds(readFileSync(cited, "utf8"), name);
    })
    .map(describeFault);

  expect(faults, citationReport(faults)).toEqual([]);
});

function describeFault({ from, line, name, path }: Citation): string {
  const cited = join(REPO, path);
  return existsSync(cited)
    ? `${from}:${String(line)}: \`${name}\` (\`${path}\`) — that file declares and re-exports no \`${name}\``
    : `${from}:${String(line)}: \`${name}\` (\`${path}\`) — there is no such file`;
}

function citationReport(faults: readonly string[]): string {
  return `Citations: ${String(faults.length)} citation${faults.length === 1 ? "" : "s"} name${faults.length === 1 ? "s" : ""} a file that does not hold the name — correct the name, or point the citation at the file that declares or re-exports it:\n  ${faults.join("\n  ")}`;
}

const PREAMBLE_TOTALS = /there are (\d+) below,\s+(\d+) of them\s+distinct/;

test("the comment reader finds a citation in a comment and none in code", () => {
  const sample = [
    'const quoted = "`inCode` (`packages/core/src/a.ts`)";',
    "// `inLine` (`packages/core/src/b.ts`)",
    "/** `inBlock` in `packages/core/src/c.ts` */",
  ].join("\n");

  expect(
    citationsIn(join(REPO, "sample.ts"), commentsOf(sample)).map(
      ({ name, path, line }) => [name, path, line],
    ),
  ).toEqual([
    ["inLine", "packages/core/src/b.ts", 2],
    ["inBlock", "packages/core/src/c.ts", 3],
  ]);
});

test("the catalogue's preamble counts the citations the walk finds", () => {
  const doc = readFileSync(join(REPO, CATALOGUE), "utf8");
  const stated = PREAMBLE_TOTALS.exec(doc);

  expect(
    stated,
    `Citations: ${CATALOGUE}'s preamble no longer states its totals in the form "there are N below, M of them distinct" — restore that sentence, or move this assertion to wherever the counting rule went`,
  ).not.toBeNull();

  const cited = citationsIn(join(REPO, CATALOGUE), proseOf(doc));
  const distinct = new Set(
    cited.map(({ name, path }) => `${name}\u0000${path}`),
  );

  expect(
    [stated?.[1], stated?.[2]],
    `Citations: ${CATALOGUE}'s preamble says it holds ${String(stated?.[1])} citations, ${String(stated?.[2])} of them distinct, and the walk finds ${String(cited.length)} and ${String(distinct.size)} — change the preamble to the numbers this run produced, which is the whole of the fix when the change was to add or remove a citation`,
  ).toEqual([String(cited.length), String(distinct.size)]);
});
