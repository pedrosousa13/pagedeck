import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const LANDING = join(import.meta.dirname, "..");
const REPO = join(LANDING, "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");
const BIN = join(LANDING, "dist", "redact.bin.js");
const REDACTOR = 'node "$GITHUB_WORKSPACE/packages/landing/dist/redact.bin.js"';

const MINIMUM_WRANGLER_LINES = 2;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
}

function redact(writes: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN]);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    const [first, ...rest] = writes;
    child.stdin.write(first ?? "", () => {
      // Long enough for the child to read the first write on its own.
      setTimeout(() => {
        for (const write of rest) child.stdin.write(write);
        child.stdin.end();
      }, 200);
    });
  });
}

test("the redactor replaces an email and an account ID, one split across two writes, and keeps the rest", async () => {
  const { code, stdout } = await redact([
    "You are logged in with an OAuth Token, associated with the email someone@example.com.\n│ Account Name │ 0123456789abcdef",
    "0123456789abcdef │\nUploaded pagedeck-landing (3.1 sec)\nno newline at the end",
  ]);
  expect(code).toBe(0);
  expect(stdout).toBe(
    "You are logged in with an OAuth Token, associated with the email <email>.\n│ Account Name │ <id> │\nUploaded pagedeck-landing (3.1 sec)\nno newline at the end",
  );
}, 30_000);

interface WranglerLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly pipefail: boolean;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function wranglerLines(file: string, source: string): WranglerLine[] {
  const lines = source.split("\n");
  const found: WranglerLine[] = [];
  lines.forEach((first, start) => {
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(first);
    if (run === null) return;
    const column = (run[1] ?? "").length;
    const rest = (run[2] ?? "").trim();
    const body: { line: number; text: string }[] = [];
    if (/^[|>]/.test(rest)) {
      for (let at = start + 1; at < lines.length; at += 1) {
        const text = lines[at] ?? "";
        if (text.trim() !== "" && indentOf(text) <= column) break;
        body.push({ line: at + 1, text: text.trim() });
      }
    } else {
      body.push({ line: start + 1, text: rest });
    }
    let pipefail = false;
    for (const { line, text } of body) {
      if (/^set\s+-o\s+pipefail\b/.test(text)) pipefail = true;
      if (/(?:^|[\s/])wrangler(?:\s|$)/.test(text)) found.push({ file, line, text, pipefail });
    }
  });
  return found;
}

function wranglerActions(file: string, source: string): { file: string; line: number; text: string }[] {
  return source
    .split("\n")
    .map((text, at) => ({ file, line: at + 1, text: text.trim() }))
    .filter(({ text }) => /^(?:-\s+)?uses:.*wrangler/i.test(text));
}

function workflows(): { file: string; source: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(WORKFLOWS, file), "utf8") }));
}

const fixture = [
  "    steps:",
  "      - uses: cloudflare/wrangler-action@v3",
  "      - run: ./node_modules/.bin/wrangler deploy",
  "      - run: |",
  "          pnpm exec wrangler",
  "          tee wrangler.txt",
].join("\n");

test("the scan finds wrangler after a path slash and at the end of a line, and a uses: step naming it", () => {
  expect(wranglerLines("fixture.yml", fixture).map(({ line }) => line)).toEqual([3, 5]);
  expect(wranglerActions("fixture.yml", fixture).map(({ line }) => line)).toEqual([2]);
});

test("every workflow line that runs wrangler pipes its stdout and stderr through the redactor before anything else reads it", () => {
  const found = workflows().flatMap(({ file, source }) => wranglerLines(file, source));
  expect(
    found.length,
    `Wrangler redaction: the scan of "${WORKFLOWS}" found ${String(found.length)} run: line${found.length === 1 ? "" : "s"} invoking wrangler, of at least ${String(MINIMUM_WRANGLER_LINES)} (deploy-worker.yml's dry run and publish), so the rule below proves nothing — fix wranglerLines() in this file; lower MINIMUM_WRANGLER_LINES only if those steps were deliberately removed`,
  ).toBeGreaterThanOrEqual(MINIMUM_WRANGLER_LINES);

  const piped = new RegExp(`\\bwrangler\\s[^|]*2>&1 \\| ${REDACTOR.replace(/[$.]/g, "\\$&")}(?: \\||$)`);
  const unredacted = found.filter(({ text, pipefail }) => !pipefail || !piped.test(text));
  expect(
    unredacted.map(({ file, line, text }) => `  .github/workflows/${file}:${String(line)} — ${text}`).join("\n"),
    `Wrangler redaction: each line below runs wrangler without "2>&1 | ${REDACTOR}" straight after it, or without "set -o pipefail" earlier in its run: block. The repository is public, so its step logs and artifacts are readable by anyone, and wrangler prints the account's email and ID (#59). Write it as "set -o pipefail" then "pnpm exec wrangler … 2>&1 | ${REDACTOR} | tee …"`,
  ).toBe("");
});

test("no workflow runs wrangler through an action, whose output the redactor cannot reach", () => {
  const actions = workflows().flatMap(({ file, source }) => wranglerActions(file, source));
  expect(
    actions.map(({ file, line, text }) => `  .github/workflows/${file}:${String(line)} — ${text}`).join("\n"),
    `Wrangler redaction: each step below runs wrangler through an action, which prints the account's email and ID to the public log with nothing between (#59). Replace it with a run: step: "set -o pipefail" then "pnpm exec wrangler … 2>&1 | ${REDACTOR} | tee …"`,
  ).toBe("");
});
