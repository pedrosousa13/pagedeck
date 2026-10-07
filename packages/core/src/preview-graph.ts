import { ConfigError } from "./exit.js";

export interface PreviewChunkFacts {
  fileName: string;
  moduleIds: readonly string[];
}

const SHIM_PREFIX = "__vite-browser-external:";

const VIRTUAL_PREFIX = "\0";

const SUBJECT = "Preview target: ";

const FIX =
  'the preview app bundles every registered component (spec §14), so import the render core from "@pagedeck/core/tree" rather than "@pagedeck/core", and leave node-only work to the loader';

function builtinsIn(chunk: PreviewChunkFacts): string[] {
  const found = new Set<string>();
  for (const id of chunk.moduleIds) {
    if (id.startsWith(SHIM_PREFIX)) found.add(id.slice(SHIM_PREFIX.length));
    else if (id.startsWith("node:")) found.add(id);
  }
  return [...found].sort();
}

function sourcesIn(chunk: PreviewChunkFacts): string[] {
  return chunk.moduleIds
    .filter(
      (id) =>
        !id.startsWith(SHIM_PREFIX) &&
        !id.startsWith(VIRTUAL_PREFIX) &&
        !id.startsWith("node:"),
    )
    .sort();
}

export function checkPreviewGraph(chunks: readonly PreviewChunkFacts[]): void {
  const faults: string[] = [];
  for (const chunk of chunks) {
    const builtins = builtinsIn(chunk);
    if (builtins.length === 0) continue;
    const sources = sourcesIn(chunk)
      .map((id) => `"${id}"`)
      .join(", ");
    faults.push(
      `  "${chunk.fileName}" — ${builtins.join(", ")}, from ${sources}`,
    );
  }
  if (faults.length === 0) return;

  const count = faults.length;
  const headline =
    count === 1
      ? "1 chunk reaches a node builtin, which a browser does not have"
      : `${String(count)} chunks reach a node builtin, which a browser does not have`;
  throw new ConfigError(
    `${SUBJECT}${headline} — ${FIX}:\n${faults.join("\n")}`,
  );
}
