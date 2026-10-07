// A deliberately small subset, not a YAML parser: the collection's schema is the trust
// boundary. Nothing is coerced, so `order: 2` is the string `"2"`.

export type FrontmatterValue = string | readonly string[];

export interface ParsedMarkdown {
  /** In written order, as text; empty, not absent, for a file with no block. */
  readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  readonly body: string;
}

const DELIMITER = "---";

// Not `split`, which would cut the value too.
const FIELD = /^([^:]+):(.*)$/;

// A bare `-` is not an item: `tags: []` says "no tags". Indentation is optional, as in YAML.
const ITEM = /^\s*-\s+(.*)$/;

// `[]` is handled apart: splitting `""` on a comma yields one empty item.
function readValue(text: string): FrontmatterValue {
  const value = text.trim();
  const quoted = unquote(value);
  if (quoted !== undefined) return quoted;
  if (value.startsWith("[") && value.endsWith("]")) {
    const items = value.slice(1, -1).trim();
    if (items === "") return [];
    return items.split(",").map((item) => item.trim());
  }
  return value;
}

function unquote(value: string): string | undefined {
  if (value.length < 2) return undefined;
  if (!value.startsWith('"') && !value.startsWith("'")) return undefined;
  const quote = value[0] as string;
  return value.endsWith(quote) ? value.slice(1, -1) : undefined;
}

// Quotes only: the bracket rule would read `- [a, b]` as a nested list.
function readItem(text: string): string {
  const value = text.trim();
  return unquote(value) ?? value;
}

interface BadLine {
  line: number;
  text: string;
}

interface RepeatedField {
  name: string;
  first: number;
  again: number;
}

function badLineReport(file: string, bad: readonly BadLine[]): string {
  const subject =
    bad.length === 1
      ? "1 frontmatter line is not a field"
      : `${String(bad.length)} frontmatter lines are not fields`;
  const detail = bad
    .map(({ line, text }) => `  line ${String(line)}: ${text}`)
    .join("\n");
  return `Markdown "${file}": ${subject} — write each as "name: value", or move the text into the body:\n${detail}`;
}

function repeatedFieldReport(
  file: string,
  repeated: readonly RepeatedField[],
): string {
  const subject =
    repeated.length === 1
      ? "1 frontmatter field is declared twice"
      : `${String(repeated.length)} frontmatter fields are declared twice`;
  const detail = repeated
    .map(
      ({ name, first, again }) =>
        `  "${name}" on lines ${String(first)} and ${String(again)}`,
    )
    .join("\n");
  return `Markdown "${file}": ${subject} — delete the line that is not wanted:\n${detail}`;
}

/** A file with no opening delimiter has no block; an opened block that never closes is refused. */
export function parseFrontmatter(
  source: string,
  file: string,
): ParsedMarkdown {
  const lines = source.split("\n");
  if (lines[0] !== DELIMITER) return { frontmatter: {}, body: source };

  const end = lines.indexOf(DELIMITER, 1);
  if (end === -1) {
    throw new Error(
      `Markdown "${file}": opens a frontmatter block that is never closed — end the block with a line holding only "${DELIMITER}", or remove the opening one`,
    );
  }

  const frontmatter: Record<string, FrontmatterValue> = {};
  const declaredAt = new Map<string, number>();
  const bad: BadLine[] = [];
  const repeated: RepeatedField[] = [];
  // Position, not indentation, makes a `-` line an item. Under a repeated field the items are
  // read and dropped, so the repeat is reported rather than its items.
  let list: { name: string; items: string[]; keep: boolean } | undefined;

  for (let index = 1; index < end; index += 1) {
    const text = lines[index] as string;
    // 1-based over the whole file: the number an editor's gutter shows.
    const line = index + 1;
    if (text.trim() === "") continue;
    const item = list === undefined ? null : ITEM.exec(text);
    if (list !== undefined && item !== null) {
      list.items.push(readItem(item[1] as string));
      if (list.keep) frontmatter[list.name] = [...list.items];
      continue;
    }
    list = undefined;
    const match = FIELD.exec(text);
    if (match === null) {
      bad.push({ line, text });
      continue;
    }
    const name = (match[1] as string).trim();
    const first = declaredAt.get(name);
    const value = match[2] as string;
    if (first !== undefined) {
      repeated.push({ name, first, again: line });
      if (value.trim() === "") list = { name, items: [], keep: false };
      continue;
    }
    declaredAt.set(name, line);
    frontmatter[name] = readValue(value);
    if (value.trim() === "") list = { name, items: [], keep: true };
  }

  // Unreadable lines first: a repeat among lines that do not parse is a verdict on an unread
  // block.
  if (bad.length > 0) throw new Error(badLineReport(file, bad));
  if (repeated.length > 0) throw new Error(repeatedFieldReport(file, repeated));

  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}
