import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const MINIMUM_CHECKOUTS = 8;

interface Checkout {
  readonly file: string;
  readonly line: number;
  readonly persistsCredentials: boolean;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .sort()
    .map((entry) => join(WORKFLOWS, entry))
    .filter((path) => statSync(path).isFile());
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function checkouts(source: string, file: string): Checkout[] {
  const lines = source.split("\n");
  const found: Checkout[] = [];

  lines.forEach((first, start) => {
    const item = /^(\s*)-\s+/.exec(first);
    if (item === null) return;
    const dash = (item[1] ?? "").length;
    const keyColumn = item[0].length;

    let end = start + 1;
    while (end < lines.length) {
      const body = lines[end] ?? "";
      if (body.trim() !== "" && indentOf(body) <= dash) break;
      end += 1;
    }
    const step = lines.slice(start, end);

    const isCheckout = step.some(
      (line, offset) =>
        /^\s*(?:-\s+)?uses:\s*actions\/checkout@/.test(line) &&
        (offset === 0 || indentOf(line) === keyColumn),
    );
    if (!isCheckout) return;

    const persistsCredentials = !step.some((line) =>
      /^\s*persist-credentials:\s*["']?false["']?\s*(?:#.*)?$/.test(line),
    );
    found.push({ file, line: start + 1, persistsCredentials });
  });

  return found;
}

test("every actions/checkout step sets persist-credentials: false", () => {
  const found = workflowFiles().flatMap((path) =>
    checkouts(
      readFileSync(path, "utf8"),
      relative(REPO, path).split(sep).join("/"),
    ),
  );
  expect(found.length, checkoutsReport(found.length)).toBeGreaterThanOrEqual(
    MINIMUM_CHECKOUTS,
  );

  const persisting = found.filter((step) => step.persistsCredentials);
  expect(persisting, persistingReport(persisting)).toEqual([]);
});

function checkoutsReport(count: number): string {
  return `Workflow checkouts: the scan of "${WORKFLOWS}" read ${String(count)} actions/checkout step${count === 1 ? "" : "s"} of at least ${String(MINIMUM_CHECKOUTS)}, so the rule below passed over too little to mean anything — checkouts() has stopped recognising the shape the workflows write a step in, and that is what to fix; lower MINIMUM_CHECKOUTS only if checkout steps were deliberately removed`;
}

function persistingReport(persisting: readonly Checkout[]): string {
  if (persisting.length === 0) return "";
  const list = persisting
    .map(({ file, line }) => `  ${file}:${String(line)}`)
    .join("\n");
  return `Workflow checkouts: ${String(persisting.length)} actions/checkout step${persisting.length === 1 ? " leaves" : "s leave"} the job's token in .git/config, where every later step, PR code included, can read it — add persist-credentials: false under the step's with:; a later step that must authenticate to git gets the credentials passed to it explicitly (#294):\n${list}`;
}
