import { isSpelled, parseBytes } from "../bytes.js";

export interface Section {
  readonly id: string;
  readonly html: string;
}

export interface Figure {
  readonly name: string;
  readonly value: string;
  readonly bytes: number;
  readonly note: string;
}

const HEADING = /<h2\b([^>]*)>/g;
const TABLE = /<table\b[\s\S]*?<\/table>/g;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/g;
const LEVEL_3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/g;

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function plainTextOf(html: string): string {
  return textOf(html)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attributeOf(html: string): string {
  return plainTextOf(html)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rowsOf(table: string): { head: boolean; cells: string[] }[] {
  return [...table.matchAll(ROW)].map((row) => {
    const cells = [...(row[1] as string).matchAll(CELL)];
    return {
      head: cells.some((cell) => cell[1] === "th"),
      cells: cells.map((cell) => (cell[3] as string).trim()),
    };
  });
}

function labelCells(table: string): string {
  const head = rowsOf(table).find((row) => row.head)?.cells.map(attributeOf) ?? [];
  return table.replace(ROW, (row) => {
    if (!/<td\b/.test(row)) return row;
    let column = 0;
    return row.replace(/<td\b([^>]*)>([\s\S]*?)<\/td>/g, (_cell, attributes: string, body: string) => {
      const label = head[column];
      const tag = column === 0 ? 'th scope="row"' : "td";
      column += 1;
      const labelled = label === undefined ? "" : ` data-label="${label}"`;
      return `<${tag}${attributes}${labelled}>${body}</${tag === "td" ? "td" : "th"}>`;
    });
  });
}

// `tabindex="0"` so a keyboard reader can scroll a wide table too.
function wrapTables(html: string): string {
  return html.replace(
    TABLE,
    (table) => `<div class="fw-table" tabindex="0">${labelCells(table)}</div>`,
  );
}

function figuresOf(lead: string): Figure[] {
  const tables = lead.match(TABLE) ?? [];
  if (tables.length === 0) {
    throw new Error(
      'Front page: found no table before the first "##" of content/index.md, and the payload ruler under the hero is that table — add a markdown table of measured figures above the first "##"',
    );
  }
  const rest = lead.replace(TABLE, "").trim();
  if (tables.length > 1 || rest !== "") {
    const extra = rest === "" ? (tables[1] as string).slice(0, 60) : rest.slice(0, 60);
    throw new Error(
      `Front page: the markup before the first "##" of content/index.md must be one table and nothing else, and it also holds "${extra}" — the template sets that markup as the payload ruler; move the rest below a "##" heading`,
    );
  }
  const rows = rowsOf(tables[0] as string);
  const columns = rows[0]?.cells.length ?? 0;
  if (columns !== 3) {
    throw new Error(
      `Front page: the table before the first "##" of content/index.md has ${String(columns)} columns, and the payload ruler reads three: who, the figure and a note — give the table those three columns, leave a note empty where a row has none, and put each figure's source in the "## Sources" section`,
    );
  }
  return rows
    .filter((row) => !row.head)
    .map(({ cells: [name = "", cell = "", note = ""] }) => {
      const value = textOf(cell);
      if (!isSpelled(value)) {
        throw new Error(
          `Front page: the payload ruler's row "${plainTextOf(name)}" in content/index.md has the figure "${value}", which is not in the site's spelling — write whole bytes below 1,000 ("307 B") or SI kilobytes to one decimal ("3.1 kB")`,
        );
      }
      return { name, value, bytes: parseBytes(value), note };
    });
}

export function splitSections(html: string): {
  figures: Figure[];
  sections: Section[];
} {
  const starts = [...html.matchAll(HEADING)];
  const sections = starts.map((match, index) => {
    const id = /\sid="([^"]+)"/.exec(match[1] as string)?.[1];
    if (id === undefined) {
      const close = html.indexOf("</h2>", match.index);
      const heading = html.slice(match.index, close === -1 ? undefined : close + 5);
      throw new Error(
        `Front page: the level-2 heading "${heading}" carries no id, and each section is labelled by its heading's id — render the page's markdown with @pagedeck/markdown-loader, which writes one on every heading`,
      );
    }
    const end = starts[index + 1]?.index ?? html.length;
    return { id, html: wrapTables(html.slice(match.index, end)) };
  });
  return {
    figures: figuresOf(html.slice(0, starts[0]?.index ?? html.length)),
    sections,
  };
}

// Two or three blocks: the stylesheet pairs radios with panels by position and
// writes three pairs.
export function tabbed(html: string, id: string): string {
  const heads = [...html.matchAll(LEVEL_3)];
  if (heads.length < 2 || heads.length > 3) {
    throw new Error(
      `Front page: the "${id}" section of content/index.md is laid out as tabs, one per "###" block, and it has ${String(heads.length)} — give it two or three "###" blocks, or take it out of the tabbed layout`,
    );
  }
  const name = `${id}-tab`;
  const radios = heads.map((head, index) => {
    const tab = `${name}-${String(index + 1)}`;
    return `<input type="radio" class="fw-tabs__radio" name="${name}" id="${tab}"${index === 0 ? " checked" : ""}><label for="${tab}">${head[1] as string}</label>`;
  });
  const panels = heads.map((head, index) => {
    const from = (head.index as number) + head[0].length;
    const to = heads[index + 1]?.index ?? html.length;
    return `<div class="fw-tabs__panel">${html.slice(from, to)}</div>`;
  });
  return [
    html.slice(0, heads[0]?.index),
    '<div class="fw-tabs">',
    `<fieldset class="fw-tabs__list" aria-labelledby="${id}">`,
    ...radios,
    "</fieldset>",
    ...panels,
    "</div>",
  ].join("");
}
