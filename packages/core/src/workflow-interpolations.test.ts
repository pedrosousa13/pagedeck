import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const MINIMUM_WORKFLOWS = 3;

const MINIMUM_RUN_BLOCKS = 15;

const UNNAMED = "(unnamed step)";

interface Interpolation {
  readonly file: string;
  readonly line: number;
  readonly step: string;
  readonly expression: string;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .sort()
    .map((entry) => join(WORKFLOWS, entry))
    .filter((path) => statSync(path).isFile());
}

interface Scan {
  readonly runBlocks: number;
  readonly found: Interpolation[];
}

function interpolations(source: string, file: string): Scan {
  const found: Interpolation[] = [];
  let runBlocks = 0;
  const lines = source.split("\n");
  let step = UNNAMED;
  // The first key of a `- ` list item is the step's `name:`; deeper keys are an
  // action's `with:` entries.
  let itemColumn = -1;

  const scan = (text: string, index: number): void => {
    for (const match of text.matchAll(/\$\{\{.*?\}\}/g)) {
      found.push({
        file,
        line: index + 1,
        step,
        expression: match[0].trim(),
      });
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;

    const item = /^\s*-\s+/.exec(line);
    if (item !== null) {
      itemColumn = item[0].length;
      step = UNNAMED;
    }

    const key = /^(\s*(?:-\s+)?)([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (key === null) continue;
    const column = (key[1] ?? "").length;
    const name = key[2] ?? "";
    const rest = (key[3] ?? "").trim();

    if (name === "name" && column === itemColumn) step = rest;

    // An empty `run:` is `defaults.run`, a mapping, not shell.
    const shell = name === "run" && rest !== "";
    if (shell) runBlocks += 1;

    if (!/^[|>]/.test(rest)) {
      if (shell) scan(rest, index - 1);
      continue;
    }

    while (index < lines.length) {
      const body = lines[index] ?? "";
      const indent = body.length - body.trimStart().length;
      if (body.trim() !== "" && indent <= column) break;
      if (shell) scan(body, index);
      index += 1;
    }
  }

  return { runBlocks, found };
}

test("no workflow interpolates a ${{ }} expression into a run block", () => {
  const files = workflowFiles();
  expect(files.length, workflowsReport(files)).toBeGreaterThanOrEqual(
    MINIMUM_WORKFLOWS,
  );

  const scans = files.map((path) =>
    interpolations(
      readFileSync(path, "utf8"),
      relative(REPO, path).split(sep).join("/"),
    ),
  );
  const runBlocks = scans.reduce((total, scan) => total + scan.runBlocks, 0);

  // Asserted before the emptiness below, and that order is the point: an empty
  // `found` is only worth reading once the scan has said it read some shell.
  expect(runBlocks, runBlocksReport(runBlocks)).toBeGreaterThanOrEqual(
    MINIMUM_RUN_BLOCKS,
  );

  const found = scans.flatMap((scan) => scan.found);
  expect(found, interpolationsReport(found)).toEqual([]);
});

function workflowsReport(files: readonly string[]): string {
  const list = files.map((path) => relative(REPO, path)).join(", ");
  return `Workflow interpolations: the walk of "${WORKFLOWS}" found ${String(files.length)} file${files.length === 1 ? "" : "s"} of at least ${String(MINIMUM_WORKFLOWS)}, so this file would check too little to mean anything — fix whatever stopped the walk returning workflow files, most likely a workflow moved under a subdirectory that the isFile() filter drops, or lower MINIMUM_WORKFLOWS if a workflow was deliberately removed. Found: ${list}`;
}

function runBlocksReport(runBlocks: number): string {
  return `Workflow interpolations: the scan read ${String(runBlocks)} run: block${runBlocks === 1 ? "" : "s"} of at least ${String(MINIMUM_RUN_BLOCKS)} across .github/workflows/, so the rule below passed over nothing and proves nothing — the run: key or the block-scalar walk in interpolations() has stopped recognising the shape the workflows are written in, and that is what to fix; lower MINIMUM_RUN_BLOCKS only if this many run: steps were deliberately removed`;
}

function interpolationsReport(found: readonly Interpolation[]): string {
  if (found.length === 0) return "";
  const list = found
    .map(
      ({ file, line, step, expression }) =>
        `  ${file}:${String(line)} in "${step}" — ${expression}`,
    )
    .join("\n");
  return `Workflow run blocks: ${String(found.length)} \${{ }} expression${found.length === 1 ? " is" : "s are"} interpolated into ${found.length === 1 ? "a run: block" : "run: blocks"} — GitHub substitutes an expression textually before the shell sees the line, so the value becomes shell source and lands in the command the runner echoes; pass it into the step as an env: entry, read it as a shell variable, and build the command's arguments as an array, which is the rule .github/workflows/deploy.yml states and the shape it uses (#337):\n${list}`;
}
