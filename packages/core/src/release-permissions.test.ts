import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const RELEASE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "release.yml",
);

const PUBLISH_JOB = "publish";
const VERIFY_JOB = "verify";

interface Job {
  readonly permissions: Record<string, string>;
  readonly needs: readonly string[];
}

interface Workflow {
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isContent(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
}

function bodyOf(lines: readonly string[], start: number, column: number): string[] {
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isContent(line) && indentOf(line) <= column) break;
    if (isContent(line)) body.push(line);
  }
  return body;
}

function inlineList(rest: string): string[] {
  return rest
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// A scalar such as `write-all` grants every scope, `id-token` among them, so it
// is kept under "*" for the assertions to see.
function permissionsAt(lines: readonly string[], start: number, column: number, rest: string): Record<string, string> {
  const scalar = rest.replace(/#.*$/, "").trim();
  if (scalar === "{}") return {};
  if (scalar !== "") return { "*": scalar };
  const permissions: Record<string, string> = {};
  for (const line of bodyOf(lines, start, column)) {
    const entry = /^\s*([\w-]+):\s*([\w-]+)/.exec(line);
    if (entry !== null) permissions[entry[1] ?? ""] = entry[2] ?? "";
  }
  return permissions;
}

function needsAt(lines: readonly string[], start: number, column: number, rest: string): string[] {
  const scalar = rest.replace(/#.*$/, "").trim();
  if (scalar !== "") return inlineList(scalar);
  return bodyOf(lines, start, column).map((line) => line.trim().replace(/^-\s*/, ""));
}

function workflow(source: string): Workflow {
  const lines = source.split("\n");
  let permissions: Record<string, string> = {};
  const jobs: Record<string, Job> = {};
  let section = "";
  let job: { permissions: Record<string, string>; needs: string[] } | undefined;
  let jobColumn = -1;

  lines.forEach((line, index) => {
    if (!isContent(line)) return;
    const key = /^(\s*)([\w-]+):(.*)$/.exec(line);
    if (key === null) return;
    const column = (key[1] ?? "").length;
    const name = key[2] ?? "";
    const rest = key[3] ?? "";

    if (column === 0) {
      section = name;
      if (name === "permissions") permissions = permissionsAt(lines, index, column, rest);
      return;
    }
    if (section !== "jobs") return;

    if (jobColumn === -1) jobColumn = column;
    if (column === jobColumn) {
      job = { permissions: {}, needs: [] };
      jobs[name] = job;
      return;
    }
    if (job === undefined || column !== jobColumn + 2) return;
    if (name === "permissions") job.permissions = permissionsAt(lines, index, column, rest);
    if (name === "needs") job.needs = needsAt(lines, index, column, rest);
  });

  return { permissions, jobs };
}

function grantsIdToken(permissions: Record<string, string>): boolean {
  return permissions["id-token"] === "write" || permissions["*"] === "write-all";
}

test("in release.yml only the publish job, which needs verify, can mint an OIDC token", () => {
  const { permissions, jobs } = workflow(readFileSync(RELEASE, "utf8"));
  const names = Object.keys(jobs);

  expect(names, jobsReport(names)).toEqual(
    expect.arrayContaining([VERIFY_JOB, PUBLISH_JOB]),
  );

  expect(grantsIdToken(permissions), workflowReport(permissions)).toBe(false);

  const minting = names.filter((name) => grantsIdToken(jobs[name]?.permissions ?? {}));
  expect(minting, mintingReport(minting)).toEqual([PUBLISH_JOB]);

  expect(jobs[VERIFY_JOB]?.permissions, verifyReport(jobs[VERIFY_JOB]?.permissions ?? {})).toEqual({
    contents: "read",
  });

  expect(jobs[PUBLISH_JOB]?.needs, needsReport(jobs[PUBLISH_JOB]?.needs ?? [])).toContain(VERIFY_JOB);
});

const NOTIFY_JOB = "notify";

function jobSource(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("release.yml tells deck-cool from its own notify job, which needs publish and only reads", () => {
  const source = readFileSync(RELEASE, "utf8");
  const { jobs } = workflow(source);

  expect(jobs[NOTIFY_JOB]?.needs, `Release permissions: "${NOTIFY_JOB}" in ${RELEASE} must need "${PUBLISH_JOB}", so deck-cool hears of a version only once it is on npm (#108)`).toContain(PUBLISH_JOB);
  expect(jobs[NOTIFY_JOB]?.permissions, `Release permissions: "${NOTIFY_JOB}" in ${RELEASE} must declare contents: read alone; its token comes from the deck-cool App, not from this job (#108)`).toEqual({ contents: "read" });
  expect(jobSource(source, NOTIFY_JOB)).toContain("DECK_APP_PRIVATE_KEY");
  expect(jobSource(source, NOTIFY_JOB)).toContain("event_type=deck-released");
  expect(
    jobSource(source, PUBLISH_JOB),
    `Release permissions: "${PUBLISH_JOB}" in ${RELEASE} names the deck-cool App, whose key does not belong beside id-token: write (#108); move the dispatch to "${NOTIFY_JOB}"`,
  ).not.toMatch(/DECK_APP|create-github-app-token|dispatches/);
});

function jobsReport(names: readonly string[]): string {
  return `Release permissions: ${RELEASE} declares the jobs ${JSON.stringify(names)}, not both "${VERIFY_JOB}" and "${PUBLISH_JOB}" — the release is split so the install, the tag check and the pack harness run in "${VERIFY_JOB}" and only "${PUBLISH_JOB}" holds id-token: write (#58); restore the two jobs, or fix workflow() here if it has stopped reading the jobs: mapping`;
}

function workflowReport(permissions: Record<string, string>): string {
  return `Release permissions: ${RELEASE}'s workflow-level permissions are ${JSON.stringify(permissions)}, which grant id-token: write to every job, so the install and the pack harness in "${VERIFY_JOB}" could mint an OIDC token that npm's trusted publisher exchanges for publish rights (#58); set the top-level permissions to contents: read and grant id-token: write on "${PUBLISH_JOB}" alone`;
}

function mintingReport(minting: readonly string[]): string {
  return `Release permissions: the jobs of ${RELEASE} that hold id-token: write are ${JSON.stringify(minting)}, and only "${PUBLISH_JOB}" may — any step of a job holding it can mint an OIDC token through ACTIONS_ID_TOKEN_REQUEST_URL, so it belongs to the job that runs nothing but the publish (#58); give every other job contents: read, and give "${PUBLISH_JOB}" id-token: write`;
}

function verifyReport(permissions: Record<string, string>): string {
  return `Release permissions: "${VERIFY_JOB}" in ${RELEASE} declares ${JSON.stringify(permissions)}, not contents: read alone — it runs an install, its scripts and the pack harness, so it gets nothing it can write with (#58); set its permissions to contents: read`;
}

function needsReport(needs: readonly string[]): string {
  return `Release permissions: "${PUBLISH_JOB}" in ${RELEASE} needs ${JSON.stringify(needs)}, not "${VERIFY_JOB}", so it would publish without the tag check and the pack harness having passed (#58); add needs: ${VERIFY_JOB} to "${PUBLISH_JOB}"`;
}
