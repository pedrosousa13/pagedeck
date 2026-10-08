import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DRY_RUN_TEXT, exec } from "./publish-to-live.harness.js";
import { redactToolOutput } from "./redact.js";

const HARNESS = join(import.meta.dirname, "publish-to-live.harness.ts");
const CONTENT = join(import.meta.dirname, "..", "content", "index.md");

test("without --apply it prints the plan, exits 0 and touches nothing", async () => {
  const before = readFileSync(CONTENT, "utf8");
  const { stdout } = await promisify(execFile)(process.execPath, [HARNESS]);
  expect(stdout).toBe(DRY_RUN_TEXT);
  expect(stdout).toContain("nothing was edited, built or deployed");
  expect(readFileSync(CONTENT, "utf8")).toBe(before);
}, 30_000);

test("a child that outlives its timeout is killed, and the message states the fix", async () => {
  const started = performance.now();
  await expect(
    exec(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], 500),
  ).rejects.toThrow(/did not finish within 0\.5 s and was killed\. Check "pnpm exec wrangler deployments list"/);
  expect(performance.now() - started).toBeLessThan(10_000);
}, 30_000);

test("a failing child's output reaches the message with emails and account IDs redacted", async () => {
  const printed =
    "You are logged in with an OAuth Token, associated with the email someone@example.com.\n" +
    "│ Account Name │ 0123456789abcdef0123456789abcdef │";
  await expect(
    exec(process.execPath, ["-e", `console.log(${JSON.stringify(printed)}); process.exit(3)`]),
  ).rejects.toThrow(
    /exited 3; its output follows, with emails and IDs redacted[\s\S]*associated with the email <email>\.\n│ Account Name │ <id> │/,
  );
}, 30_000);

test("redaction leaves the rest of the output as it was", () => {
  expect(redactToolOutput("Uploaded pagedeck-landing (3.1 sec)\nhttps://pagedeck-landing.pedrodsousa.workers.dev")).toBe(
    "Uploaded pagedeck-landing (3.1 sec)\nhttps://pagedeck-landing.pedrodsousa.workers.dev",
  );
  expect(redactToolOutput("a.b+c@mail.example.org ABCDEF0123456789ABCDEF0123456789")).toBe("<email> <id>");
});

test("an ID or email is redacted whatever non-hex character sits beside it, and a longer hex run is left alone", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(redactToolOutput(`\x1b[33m${id}\x1b[0m`)).toBe("\x1b[33m<id>\x1b[0m");
  expect(redactToolOutput(`account_${id}`)).toBe("account_<id>");
  expect(redactToolOutput(`https://dash.cloudflare.com/${id}/workers`)).toBe("https://dash.cloudflare.com/<id>/workers");
  expect(redactToolOutput(id.toUpperCase())).toBe("<id>");
  expect(redactToolOutput("\x1b[1mme@mail.example\x1b[0m")).not.toContain("me@mail.example");
  expect(redactToolOutput(`${id}0`)).toBe(`${id}0`);
});
