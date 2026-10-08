import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LANDING = join(import.meta.dirname, "..");
const BIN = join(LANDING, "..", "core", "dist", "bin.js");
const CONTENT = join(LANDING, "content", "index.md");
const LIVE = "https://pagedeck-landing.pedrodsousa.workers.dev/";
const RUNS = 3;
const POLL_INTERVAL_MS = 1_000;
const GIVE_UP_MS = 600_000;
const DEPLOY_TIMEOUT_MS = 300_000;
const ANCHOR = "Build it from a clone, or [see every feature running](/features/).";

export const DRY_RUN_TEXT = `Publish-to-live: dry run, nothing was edited, built or deployed.
With --apply, this harness would:
  1. add a dated probe sentence to ${CONTENT}, ${String(RUNS)} times, one per run;
  2. run pagedeck sync and pagedeck build in ${LANDING};
  3. run "pnpm exec wrangler deploy" there, which publishes to ${LIVE};
  4. request ${LIVE} at most once a second until it serves the probe;
  5. put the file back, build and deploy the unedited content, and wait for ${LIVE} to serve it byte for byte.
Run "pnpm bench:landing-publish --apply" only with the maintainer's approval of the deploys.
`;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HEX_ID = /\b[0-9a-f]{32}\b/gi;

/** wrangler prints the account's email and ID; neither belongs in a message. */
export function redactToolOutput(text: string): string {
  return text.replace(EMAIL, "<email>").replace(HEX_ID, "<id>");
}

interface Run {
  readonly run: number;
  readonly deployMs: number;
  readonly firstServedMs: number;
  readonly polls: number;
}

const children = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}

let interrupted = false;

export function exec(
  command: string,
  args: readonly string[],
  timeoutMs?: number,
  restoring = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (interrupted && !restoring) {
      reject(new Error(`Publish-to-live: interrupted, so "${command} ${args.join(" ")}" was not started`));
      return;
    }
    const child = spawn(command, args, {
      cwd: LANDING,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      // Its own process group: a terminal's Ctrl-C reaches this process only, and
      // the handler stops the child before it redeploys.
      detached: true,
    });
    children.add(child);
    let output = "";
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killGroup(child, "SIGKILL");
          }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      const line = `"${command} ${args.join(" ")}" in ${LANDING}`;
      if (timedOut) {
        reject(
          new Error(
            `Publish-to-live: ${line} did not finish within ${String((timeoutMs ?? 0) / 1000)} s and was killed. Check "pnpm exec wrangler deployments list" there for whether a version went live and Cloudflare's status page for an outage, then run again`,
          ),
        );
      } else if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `Publish-to-live: ${line} ${signal === null ? `exited ${String(code)}` : `was stopped by ${signal}`}; its output follows, with emails and IDs redacted. Fix what it names and run again:\n${redactToolOutput(output)}`,
          ),
        );
      }
    });
  });
}

async function buildLanding(restoring = false): Promise<string> {
  await exec(process.execPath, [BIN, "sync"], undefined, restoring);
  await exec(process.execPath, [BIN, "build"], undefined, restoring);
  return readFileSync(join(LANDING, "site", "index.html"), "utf8");
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// One request at a time, each at least POLL_INTERVAL_MS after the one before started.
async function pollUntil(
  start: number,
  served: (body: string) => boolean,
  stopped: () => boolean,
): Promise<{ at: number; polls: number; etag: string | null }> {
  let polls = 0;
  for (;;) {
    const sent = performance.now();
    if (stopped()) throw new Error("Publish-to-live: polling stopped because the deploy failed or the run was interrupted");
    if (sent - start > GIVE_UP_MS) {
      throw new Error(
        `Publish-to-live: ${LIVE} did not serve the new bytes within ${String(GIVE_UP_MS / 1000)} s of the deploy starting (${String(polls)} requests). Check the deploy's output and "pnpm exec wrangler deployments list" in ${LANDING}`,
      );
    }
    polls += 1;
    const response = await fetch(LIVE, { cache: "no-store" });
    const body = await response.text();
    if (response.ok && served(body)) {
      return { at: performance.now(), polls, etag: response.headers.get("etag") };
    }
    await sleep(Math.max(0, sent + POLL_INTERVAL_MS - performance.now()));
  }
}

let deployed = false;

async function deployAndWait(
  served: (body: string) => boolean,
  restoring = false,
): Promise<{ deployMs: number; firstServedMs: number; polls: number; etag: string | null }> {
  const start = performance.now();
  deployed = true;
  let failed = false;
  const deploy = exec("pnpm", ["exec", "wrangler", "deploy"], DEPLOY_TIMEOUT_MS, restoring).then(
    () => performance.now(),
    (cause: unknown) => {
      failed = true;
      throw cause;
    },
  );
  const [ended, first] = await Promise.all([
    deploy,
    pollUntil(start, served, () => failed || (interrupted && !restoring)),
  ]);
  return {
    deployMs: Math.round(ended - start),
    firstServedMs: Math.round(first.at - start),
    polls: first.polls,
    etag: first.etag,
  };
}

async function stopChildren(): Promise<void> {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((done) => {
          child.once("close", () => done());
          killGroup(child, "SIGTERM");
        }),
    ),
  );
}

let cleanup: Promise<void> | undefined;

/** Once, whether `finally` or a signal reaches it first: the live site ends on the unedited content. */
function restore(original: string): Promise<void> {
  cleanup ??= (async () => {
    await stopChildren();
    writeFileSync(CONTENT, original);
    if (!deployed) return;
    const restored = await buildLanding(true);
    const back = await deployAndWait((body) => body === restored, true);
    process.stdout.write(
      `restored: deploy ${String(back.deployMs)} ms, ${LIVE} serves the local build of the unedited content byte for byte, etag ${String(back.etag)}\n`,
    );
  })();
  return cleanup;
}

async function main(args: readonly string[]): Promise<number> {
  if (!args.includes("--apply")) {
    process.stdout.write(DRY_RUN_TEXT);
    return 0;
  }

  const original = readFileSync(CONTENT, "utf8");
  if (!original.includes(ANCHOR)) {
    throw new Error(
      `Publish-to-live: ${CONTENT} no longer contains the line this harness edits, "${ANCHOR}". Set ANCHOR in ${import.meta.filename} to a sentence the front page renders`,
    );
  }

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    // `on`, not `once`: a second Ctrl-C must not kill the restore half way.
    process.on(signal, () => {
      interrupted = true;
      process.stderr.write(`Publish-to-live: ${signal}, restoring ${CONTENT} and the live site\n`);
      restore(original).then(
        () => process.exit(code),
        (cause: unknown) => {
          process.stderr.write(
            `Publish-to-live: restoring after ${signal} failed; check ${CONTENT} against git and redeploy main's build by hand:\n${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
          process.exit(code);
        },
      );
    });
  }

  const runs: Run[] = [];
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      const token = `Publish-to-live probe ${String(run)}, ${new Date().toISOString()}.`;
      writeFileSync(CONTENT, original.replace(ANCHOR, `${ANCHOR} ${token}`));
      const built = await buildLanding();
      if (!built.includes(token)) {
        throw new Error(
          `Publish-to-live: the build of ${CONTENT} with the probe sentence did not render it into site/index.html, so there is nothing to poll for. Move ANCHOR to a sentence the front page renders as written`,
        );
      }
      const timed = await deployAndWait((body) => body.includes(token));
      runs.push({ run, ...timed });
      process.stdout.write(
        `run ${String(run)}: deploy ${String(timed.deployMs)} ms, first served ${String(timed.firstServedMs)} ms, ${String(timed.polls)} requests\n`,
      );
    }
  } finally {
    await restore(original);
  }

  process.stdout.write(
    `\n${new Date().toISOString()}, ${LIVE}\nrun  deploy (ms)  first served (ms)  requests\n${runs
      .map(
        (one) =>
          `${String(one.run).padEnd(4)} ${String(one.deployMs).padStart(11)}  ${String(one.firstServedMs).padStart(17)}  ${String(one.polls).padStart(8)}`,
      )
      .join("\n")}\n`,
  );
  return 0;
}

// Only when run directly: the test imports this module's pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // After a signal, its handler restores and exits non-zero.
    if (!interrupted) throw error;
  }
}
