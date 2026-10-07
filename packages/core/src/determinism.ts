import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const STAMPED_DOCUMENT = "manifest.json";

export type Difference = "bytes" | "first-only" | "second-only";

export interface OutputDifference {
  path: string;
  difference: Difference;
}

/**
 * Not `readManifest`: it gates the schema version, which is not nondeterminism.
 */
function withoutStamp(contents: string): string {
  try {
    const { build: _build, ...rest } = JSON.parse(contents) as Record<
      string,
      unknown
    >;
    return JSON.stringify(rest);
  } catch {
    return contents;
  }
}

function filePaths(root: string): Set<string> {
  const paths = new Set<string>();
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name));
    paths.add(path.split(sep).join("/"));
  }
  return paths;
}

function sameBytes(first: string, second: string, path: string): boolean {
  const read = (root: string): string =>
    path === STAMPED_DOCUMENT
      ? withoutStamp(readFileSync(join(root, path), "utf8"))
      : readFileSync(join(root, path), "latin1");
  return read(first) === read(second);
}

/**
 * Read as `latin1`, which round-trips every byte, so a change of encoding or
 * byte-order mark between runs is a difference.
 */
export function diffOutputTrees(
  first: string,
  second: string,
): readonly OutputDifference[] {
  const before = filePaths(first);
  const after = filePaths(second);
  const differences: OutputDifference[] = [];
  for (const path of new Set([...before, ...after])) {
    if (!after.has(path)) differences.push({ path, difference: "first-only" });
    else if (!before.has(path)) {
      differences.push({ path, difference: "second-only" });
    } else if (!sameBytes(first, second, path)) {
      differences.push({ path, difference: "bytes" });
    }
  }
  return differences.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface ComparedTrees {
  first: string;
  second: string;
}

export function outputDifferenceReport(
  trees: ComparedTrees,
  differences: readonly OutputDifference[],
): string {
  const count = differences.length;
  const subject =
    count === 1 ? "1 file differs" : `${String(count)} files differ`;
  const reasons: Record<Difference, string> = {
    bytes: "the bytes differ",
    "first-only": `only ${trees.first} has it`,
    "second-only": `only ${trees.second} has it`,
  };
  const lines = differences.map(
    (entry) => `  ${entry.path} — ${reasons[entry.difference]}`,
  );
  return `Build-twice determinism: ${subject} between "${trees.first}" and "${trees.second}" — two builds of one unchanged site must emit the same bytes, so the build must not read a clock, a random source or an unordered collection:\n${lines.join("\n")}`;
}
