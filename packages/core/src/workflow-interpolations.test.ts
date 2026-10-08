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
  readonly run: Interpolation[];
  readonly scripts: Interpolation[];
}

interface Segment {
  readonly line: number;
  readonly text: string;
}

const KEY =
  /^(\s*(?:-\s+)?)(?:"([\w-]+)"|'([\w-]+)'|([A-Za-z_][\w-]*))\s*:(.*)$/;

const FLOW_KEY =
  /(?:^|[{,])\s*(?:"([\w-]+)"|'([\w-]+)'|([A-Za-z_][\w-]*))\s*:\s*/g;

const GITHUB_SCRIPT = /^["']?actions\/github-script@/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function joined(segments: readonly Segment[]): {
  readonly text: string;
  readonly lineAt: (offset: number) => number;
} {
  const starts: number[] = [];
  let text = "";
  for (const segment of segments) {
    if (starts.length > 0) text += "\n";
    starts.push(text.length);
    text += segment.text;
  }
  const lineAt = (offset: number): number => {
    let at = 0;
    starts.forEach((start, index) => {
      if (start <= offset) at = index;
    });
    return segments[at]?.line ?? 0;
  };
  return { text, lineAt };
}

function interpolations(source: string, file: string): Scan {
  const run: Interpolation[] = [];
  const scripts: { readonly stepStart: number; readonly found: Interpolation }[] = [];
  const usesOf = new Map<number, string>();
  let runBlocks = 0;
  const lines = source.split("\n");
  let step = UNNAMED;
  let stepStart = -1;
  // The first key of a `- ` list item is the step's `name:`; deeper keys are an
  // action's `with:` entries.
  let itemColumn = -1;
  let index = 0;

  const scan = (
    text: string,
    lineAt: (offset: number) => number,
    key: "run" | "script",
  ): void => {
    for (const match of text.matchAll(/\$\{\{[\s\S]*?(?:\}\}|$)/g)) {
      const found: Interpolation = {
        file,
        line: lineAt(match.index),
        step,
        expression: match[0].replace(/\s+/g, " ").trim(),
      };
      if (key === "run") run.push(found);
      else scripts.push({ stepStart, found });
    }
  };

  const continuation = (first: Segment, column: number): Segment[] => {
    const segments = [first];
    while (index < lines.length) {
      const body = lines[index] ?? "";
      if (body.trim() !== "" && indentOf(body) <= column) break;
      segments.push({ line: index + 1, text: body });
      index += 1;
    }
    return segments;
  };

  const flow = (segments: readonly Segment[]): void => {
    const { text, lineAt } = joined(segments);
    const keys = [...text.matchAll(FLOW_KEY)];
    keys.forEach((match, at) => {
      const name = match[1] ?? match[2] ?? match[3] ?? "";
      const from = match.index + match[0].length;
      const value = text.slice(from, keys[at + 1]?.index ?? text.length);
      const scalar = value.replace(/[\s,}\]]+$/, "");
      if (name === "name") step = scalar;
      if (name === "uses") usesOf.set(stepStart, scalar);
      if (name === "run" && scalar !== "") {
        runBlocks += 1;
        scan(value, (offset) => lineAt(from + offset), "run");
      }
      if (name === "script") {
        scan(value, (offset) => lineAt(from + offset), "script");
      }
    });
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;

    const item = /^\s*-\s+/.exec(line);
    if (item !== null) {
      itemColumn = item[0].length;
      step = UNNAMED;
      stepStart = index - 1;
      const rest = line.slice(item[0].length);
      if (rest.startsWith("{")) {
        flow(continuation({ line: index, text: rest }, itemColumn - 1));
        continue;
      }
    }

    const key = KEY.exec(line);
    if (key === null) continue;
    const column = (key[1] ?? "").length;
    const name = key[2] ?? key[3] ?? key[4] ?? "";
    const rest = (key[5] ?? "").trim();

    if (name === "name" && column === itemColumn) step = rest;
    if (name === "uses" && column === itemColumn) usesOf.set(stepStart, rest);

    if (/^[{[]/.test(rest)) {
      flow(continuation({ line: index, text: rest }, column));
      continue;
    }

    // An empty `run:` is `defaults.run`, a mapping, not shell.
    const shell = name === "run" && rest !== "";
    if (shell) runBlocks += 1;
    const script = name === "script" && rest !== "";

    if (!shell && !script) {
      if (!/^[|>]/.test(rest)) continue;
      continuation({ line: index, text: rest }, column);
      continue;
    }

    const { text, lineAt } = joined(
      continuation({ line: index, text: rest }, column),
    );
    scan(text, lineAt, shell ? "run" : "script");
  }

  return {
    runBlocks,
    run,
    scripts: scripts
      .filter(({ stepStart: start }) =>
        GITHUB_SCRIPT.test(usesOf.get(start) ?? ""),
      )
      .map(({ found }) => found),
  };
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

  const run = scans.flatMap((scan) => scan.run);
  expect(run, interpolationsReport(run)).toEqual([]);
  const scripts = scans.flatMap((scan) => scan.scripts);
  expect(scripts, scriptsReport(scripts)).toEqual([]);
});

function workflowsReport(files: readonly string[]): string {
  const list = files.map((path) => relative(REPO, path)).join(", ");
  return `Workflow interpolations: the walk of "${WORKFLOWS}" found ${String(files.length)} file${files.length === 1 ? "" : "s"} of at least ${String(MINIMUM_WORKFLOWS)}, so this file would check too little to mean anything — fix whatever stopped the walk returning workflow files, most likely a workflow moved under a subdirectory that the isFile() filter drops, or lower MINIMUM_WORKFLOWS if a workflow was deliberately removed. Found: ${list}`;
}

function runBlocksReport(runBlocks: number): string {
  return `Workflow interpolations: the scan read ${String(runBlocks)} run: block${runBlocks === 1 ? "" : "s"} of at least ${String(MINIMUM_RUN_BLOCKS)} across .github/workflows/, so the rule below passed over nothing and proves nothing — the run: key or the block-scalar walk in interpolations() has stopped recognising the shape the workflows are written in, and that is what to fix; lower MINIMUM_RUN_BLOCKS only if this many run: steps were deliberately removed`;
}

function listed(found: readonly Interpolation[]): string {
  return found
    .map(
      ({ file, line, step, expression }) =>
        `  ${file}:${String(line)} in "${step}" — ${expression}`,
    )
    .join("\n");
}

function interpolationsReport(found: readonly Interpolation[]): string {
  if (found.length === 0) return "";
  const list = listed(found);
  return `Workflow run blocks: ${String(found.length)} \${{ }} expression${found.length === 1 ? " is" : "s are"} interpolated into ${found.length === 1 ? "a run: block" : "run: blocks"} — GitHub substitutes an expression textually before the shell sees the line, so the value becomes shell source and lands in the command the runner echoes; pass it into the step as an env: entry, read it as a shell variable, and build the command's arguments as an array, which is the rule .github/workflows/deploy.yml states and the shape it uses (#337):\n${list}`;
}

function scriptsReport(found: readonly Interpolation[]): string {
  if (found.length === 0) return "";
  return `Workflow github-script steps: ${String(found.length)} \${{ }} expression${found.length === 1 ? " is" : "s are"} interpolated into the script: input of an actions/github-script step — GitHub substitutes an expression textually before Node parses the script, so the value becomes JavaScript source; pass it into the step as an env: entry and read it as process.env.NAME, the same rule run: blocks follow (#337), which reaches github-script on #61:\n${listed(found)}`;
}

function expressionsIn(source: string): string[] {
  const { run, scripts } = interpolations(source, "fixture.yml");
  return [...run, ...scripts].map(
    ({ line, expression }) => `${String(line)} ${expression}`,
  );
}

test("interpolations() reads an expression that spans lines of a run block", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Echo",
    "        run: |",
    "          echo ${{",
    "            github.event.inputs.origin }}",
  ].join("\n");
  expect(expressionsIn(source)).toEqual([
    "6 ${{ github.event.inputs.origin }}",
  ]);
});

test("interpolations() reads quoted run keys", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    '      - "run": echo ${{ inputs.a }}',
    "      - 'run': |",
    "          echo ${{ inputs.b }}",
  ].join("\n");
  expect(expressionsIn(source)).toEqual([
    "4 ${{ inputs.a }}",
    "6 ${{ inputs.b }}",
  ]);
});

test("interpolations() reads a flow-style run key", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - { name: Echo, run: echo ${{ inputs.a }} }",
    "      - { name: Safe, run: echo ok, if: ${{ inputs.b }} }",
  ].join("\n");
  expect(expressionsIn(source)).toEqual(["4 ${{ inputs.a }}"]);
});

test("interpolations() reads the script input of an actions/github-script step and no other action's", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Comment",
    "        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1",
    "        with:",
    "          script: |",
    "            console.log(`${{ inputs.a }}`)",
    "      - name: Other",
    "        uses: example/other@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v1.0.0",
    "        with:",
    "          script: ${{ inputs.b }}",
  ].join("\n");
  expect(expressionsIn(source)).toEqual(["8 ${{ inputs.a }}"]);
});
