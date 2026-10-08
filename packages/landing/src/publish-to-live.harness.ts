import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LANDING = join(import.meta.dirname, "..");
const BIN = join(LANDING, "..", "core", "dist", "bin.js");
const CONTENT = join(LANDING, "content", "index.md");
const LIVE = "https://pagedeck-landing.pedrodsousa.workers.dev/";
const RUNS = 3;
const POLL_INTERVAL_MS = 1_000;
const GIVE_UP_MS = 600_000;
const ANCHOR = "Build it from a clone, or [see every feature running](/features/).";

interface Run {
  readonly run: number;
  readonly deployMs: number;
  readonly firstServedMs: number;
  readonly polls: number;
}

function exec(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: LANDING,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            `Publish-to-live: "${command} ${args.join(" ")}" in ${LANDING} exited ${String(code)}; its output follows, fix what it names and run again:\n${output}`,
          ),
        );
    });
  });
}

async function buildLanding(): Promise<string> {
  await exec(process.execPath, [BIN, "sync"]);
  await exec(process.execPath, [BIN, "build"]);
  return readFileSync(join(LANDING, "site", "index.html"), "utf8");
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// One request at a time, each at least POLL_INTERVAL_MS after the one before started.
async function pollUntil(
  start: number,
  served: (body: string) => boolean,
): Promise<{ at: number; polls: number; etag: string | null }> {
  let polls = 0;
  for (;;) {
    const sent = performance.now();
    if (sent - start > GIVE_UP_MS) {
      throw new Error(
        `Publish-to-live: ${LIVE} did not serve the new bytes within ${String(GIVE_UP_MS / 1000)} s of the deploy starting (${String(polls)} requests). Check the deploy's output and \`pnpm exec wrangler deployments list\` in ${LANDING}`,
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

async function deployAndWait(
  served: (body: string) => boolean,
): Promise<{ deployMs: number; firstServedMs: number; polls: number; etag: string | null }> {
  const start = performance.now();
  const deploy = exec("pnpm", ["exec", "wrangler", "deploy"]).then(() => performance.now());
  const [deployed, first] = await Promise.all([deploy, pollUntil(start, served)]);
  return {
    deployMs: Math.round(deployed - start),
    firstServedMs: Math.round(first.at - start),
    polls: first.polls,
    etag: first.etag,
  };
}

const original = readFileSync(CONTENT, "utf8");
if (!original.includes(ANCHOR)) {
  throw new Error(
    `Publish-to-live: ${CONTENT} no longer contains the line this harness edits, "${ANCHOR}". Set ANCHOR in ${import.meta.filename} to a sentence the front page renders`,
  );
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
  writeFileSync(CONTENT, original);
  // The live site ends on the unedited content, whatever happened above.
  const restored = await buildLanding();
  const back = await deployAndWait((body) => body === restored);
  process.stdout.write(
    `restored: deploy ${String(back.deployMs)} ms, ${LIVE} serves the local build of the unedited content byte for byte, etag ${String(back.etag)}\n`,
  );
}

process.stdout.write(
  `\n${new Date().toISOString()}, ${LIVE}\nrun  deploy (ms)  first served (ms)  requests\n${runs
    .map(
      (one) =>
        `${String(one.run).padEnd(4)} ${String(one.deployMs).padStart(11)}  ${String(one.firstServedMs).padStart(17)}  ${String(one.polls).padStart(8)}`,
    )
    .join("\n")}\n`,
);
