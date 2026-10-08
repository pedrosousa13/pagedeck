import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const MINIMUM_USES = 25;

interface Uses {
  readonly file: string;
  readonly line: number;
  readonly ref: string;
  readonly pinned: boolean;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .sort()
    .map((entry) => join(WORKFLOWS, entry))
    .filter((path) => statSync(path).isFile());
}

const USES =
  /(?:^\s*(?:-\s+)?|[{,]\s*)(?:uses|"uses"|'uses')\s*:\s*(["']?)([^\s"',}]*)\1/g;

const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;

const VERSION_COMMENT = /^\s+#\s*v\d/;

function uses(source: string, file: string): Uses[] {
  return source.split("\n").flatMap((line, index) => {
    if (line.trimStart().startsWith("#")) return [];
    return [...line.matchAll(USES)].map((match) => {
      const ref = match[2] ?? "";
      const after = line.slice(match.index + match[0].length);
      const pinned =
        ref.startsWith("./") ||
        (PINNED.test(ref) && VERSION_COMMENT.test(after));
      return { file, line: index + 1, ref, pinned };
    });
  });
}

test("every uses: in a workflow is pinned to a commit SHA with a version comment", () => {
  const found = workflowFiles().flatMap((path) =>
    uses(readFileSync(path, "utf8"), relative(REPO, path).split(sep).join("/")),
  );
  expect(found.length, usesReport(found.length)).toBeGreaterThanOrEqual(
    MINIMUM_USES,
  );

  const unpinned = found.filter(({ pinned }) => !pinned);
  expect(unpinned, unpinnedReport(unpinned)).toEqual([]);
});

function usesReport(count: number): string {
  return `Workflow pins: the scan of .github/workflows/ read ${String(count)} uses: line${count === 1 ? "" : "s"} of at least ${String(MINIMUM_USES)}, so the rule below passed over too little to mean anything — uses() has stopped recognising the shape the workflows write a uses: key in, and that is what to fix; lower MINIMUM_USES only if action steps were deliberately removed`;
}

function unpinnedReport(unpinned: readonly Uses[]): string {
  if (unpinned.length === 0) return "";
  const list = unpinned
    .map(({ file, line, ref }) => `  ${file}:${String(line)} — ${ref}`)
    .join("\n");
  return `Workflow pins: ${String(unpinned.length)} uses: line${unpinned.length === 1 ? " is" : "s are"} not pinned to a full commit SHA with a version comment — a tag or branch is a pointer its owner can move, so the job would run whatever it points at next (#121); resolve the tag with gh api repos/<owner>/<repo>/commits/<tag> --jq .sha and write owner/repo@<40-hex SHA> # vX.Y.Z:\n${list}`;
}

function faultsIn(source: string): string[] {
  return uses(source, "fixture.yml")
    .filter(({ pinned }) => !pinned)
    .map(({ line, ref }) => `${String(line)} ${ref}`);
}

const SHA = "11d5960a326750d5838078e36cf38b85af677262";

test("uses() refuses a tag, a branch, a short SHA, a docker reference and a pin whose version comment does not follow the SHA, at step and job level", () => {
  const source = [
    "jobs:",
    "  call:",
    "    uses: example/workflows/.github/workflows/ci.yml@main",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - uses: actions/checkout@${SHA.slice(0, 7)} # v4.4.0`,
    `      - uses: actions/checkout@${SHA}`,
    `      - uses: actions/checkout@${SHA} # latest`,
    `      - name: Quoted`,
    `        "uses": "actions/checkout@v4"`,
    `      - { name: Flow, uses: actions/checkout@v4 }`,
    `      - uses: docker://alpine@sha256:${"a".repeat(64)} # v3.20`,
    `      - uses: actions/checkout@${SHA} junk # v4`,
  ].join("\n");
  expect(faultsIn(source)).toEqual([
    "3 example/workflows/.github/workflows/ci.yml@main",
    "6 actions/checkout@v4",
    `7 actions/checkout@${SHA.slice(0, 7)}`,
    `8 actions/checkout@${SHA}`,
    `9 actions/checkout@${SHA}`,
    "11 actions/checkout@v4",
    "12 actions/checkout@v4",
    `13 docker://alpine@sha256:${"a".repeat(64)}`,
    `14 actions/checkout@${SHA}`,
  ]);
});

test("uses() admits a SHA pin with a version comment, an action in a subdirectory and a local reference", () => {
  const source = [
    "jobs:",
    "  call:",
    "    uses: ./.github/workflows/deploy-worker.yml",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    `      - uses: example/monorepo/path/to/action@${SHA} # v1`,
    "      - uses: ./.github/actions/setup",
  ].join("\n");
  expect(uses(source, "fixture.yml")).toHaveLength(4);
  expect(faultsIn(source)).toEqual([]);
});
