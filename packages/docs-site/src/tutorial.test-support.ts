import { join } from "node:path";

export const TUTORIAL = join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "tutorials",
  "your-first-site.md",
);

export const STARTER_TEMPLATE = join(
  import.meta.dirname,
  "..",
  "..",
  "create-pagedeck",
  "template",
);

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
