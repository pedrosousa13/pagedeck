import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface Coalesced {
  /** Asks for a run. Folds into the run already waiting, if there is one. */
  request(): void;
  /** Settles once no run is going or waiting; rejects with the first failure since the last call. */
  idle(): Promise<void>;
}

/**
 * One run at a time, and at most one waiting: the rule a CI concurrency group
 * applies by default. The waiting run starts after every request it absorbed,
 * so it reads the content the newest of them announced.
 */
export function coalesce(run: () => Promise<void>): Coalesced {
  let going: Promise<void> | undefined;
  let waiting = false;
  let failure: { error: unknown } | undefined;

  const start = (): void => {
    going = run()
      .catch((error: unknown) => {
        failure ??= { error };
      })
      .finally(() => {
        going = undefined;
        if (waiting) {
          waiting = false;
          start();
        }
      });
  };

  return {
    request() {
      if (going === undefined) start();
      else waiting = true;
    },
    async idle() {
      while (going !== undefined) await going;
      const failed = failure;
      failure = undefined;
      if (failed !== undefined) throw failed.error;
    },
  };
}

export interface PublishOptions {
  /** The directory holding `pagedeck.config.ts`. */
  readonly site: string;
  /** Where the last successful run's store, retention store and output are kept. */
  readonly state: string;
  /** The path of `pagedeck`'s `bin.js`. */
  readonly pagedeck: string;
  /** The deploy command's script and arguments; `--apply --prune` are added. */
  readonly deploy: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Per step. Default 600000. */
  readonly timeoutMs?: number;
}

export interface PublishStep {
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PublishResult {
  readonly ok: boolean;
  /** The step that failed: `sync`, `build` or `deploy`. */
  readonly failed?: string;
  readonly incremental: boolean;
  readonly steps: readonly PublishStep[];
}

/** The example's `content.db`, the retention store, and `outDir`. */
const RETAINED = ["content.db", ".pagedeck", "site"] as const;

function replace(from: string, to: string): void {
  for (const name of RETAINED) {
    rmSync(join(to, name), { recursive: true, force: true });
    if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

function step(argv: readonly string[], cwd: string, options: PublishOptions): Promise<PublishStep> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      { cwd, env: options.env, timeout: options.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ argv, code, stdout, stderr });
      },
    );
  });
}

/**
 * One run of the publishing job. It starts from the state the last successful run
 * saved and saves its own only once the deploy succeeded, so a failed run leaves
 * nothing behind that the next run builds on.
 */
export async function publish(options: PublishOptions): Promise<PublishResult> {
  mkdirSync(options.state, { recursive: true });
  const incremental = existsSync(join(options.state, "content.db"));
  replace(options.state, options.site);
  const flag = incremental ? ["--incremental"] : [];
  const plan: [string, string[]][] = [
    ["sync", [options.pagedeck, "sync", ...flag]],
    ["build", [options.pagedeck, "build", ...flag]],
    ["deploy", [...options.deploy, "--apply", "--prune"]],
  ];
  const steps: PublishStep[] = [];
  for (const [name, argv] of plan) {
    const ran = await step(argv, options.site, options);
    steps.push(ran);
    if (ran.code !== 0) return { ok: false, failed: name, incremental, steps };
  }
  replace(options.site, options.state);
  return { ok: true, incremental, steps };
}
