import { join } from "node:path";

export const TUTORIAL = join(import.meta.dirname, "..", "tutorials", "your-first-site.md");

export const STARTER_TEMPLATE = join(
  import.meta.dirname,
  "..",
  "..",
  "create-pagedeck",
  "template",
);

const indent = (line: string): number => line.length - line.trimStart().length;

// The fence's lines, in order and next to each other, with every line moved by one indent:
// an excerpt from inside a function may drop the function's indentation.
export function quotes(source: string, code: string): boolean {
  const wanted = code.trimEnd().split("\n");
  const lines = source.split("\n");
  const first = wanted[0] as string;
  return lines.some((_, start) => {
    const shift = indent(lines[start] as string) - indent(first);
    if (shift < 0) return false;
    return wanted.every((line, offset) => {
      const real = lines[start + offset];
      if (real === undefined) return false;
      return line.trim() === "" ? real.trim() === "" : real === " ".repeat(shift) + line;
    });
  });
}

export interface Fence {
  lang: string;
  code: string;
  file: string | undefined;
}

// The file name is read from the last non-blank line before the fence.
export function fences(markdown: string): Fence[] {
  const found: Fence[] = [];
  const lines = markdown.split("\n");
  let lead = "";
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as string;
    const open = /^```(\S*)$/.exec(line);
    if (open === null) {
      if (line.trim() !== "") lead = line;
      continue;
    }
    const body: string[] = [];
    for (at += 1; at < lines.length && lines[at] !== "```"; at += 1) {
      body.push(lines[at] as string);
    }
    found.push({
      lang: open[1] as string,
      code: `${body.join("\n")}\n`,
      file: /`([^`]+)`:$/.exec(lead)?.[1],
    });
    lead = "";
  }
  return found;
}
