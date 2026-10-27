import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { loadConfig, RETENTION_DIR } from "@pagedeck/core";

export interface Coalesced {
  /** Asks for a run. Folds into the run already waiting, if there is one. */
  request(): void;
  /**
   * Settles once no run is going or waiting. Rejects with an `AggregateError` holding
   * every failure since the last call, oldest first.
   */
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
  const failures: unknown[] = [];

  const start = (): void => {
    going = run()
      .catch((error: unknown) => {
        failures.push(error);
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
      const failed = failures.splice(0);
      if (failed.length > 0) {
        throw new AggregateError(failed, `${String(failed.length)} publishing runs failed since the last idle()`);
      }
    },
  };
}

export type StepName = "sync" | "build" | "deploy";

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
  /** Awaited after each step that succeeded, before the next one starts. */
  readonly afterStep?: (step: StepName) => Promise<void>;
}

export interface PublishStep {
  readonly name: StepName;
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type PublishResult =
  | { readonly ok: true; readonly incremental: boolean; readonly steps: readonly PublishStep[] }
  | {
      readonly ok: false;
      readonly failed: StepName;
      readonly incremental: boolean;
      readonly steps: readonly PublishStep[];
    };

/** Relative to the site directory: the store and its SQLite journals, the retention store, `outDir`. */
async function retained(site: string): Promise<{ store: string; paths: string[] }> {
  const config = await loadConfig(site);
  const store = relative(site, config.storePath);
  const paths = [store, `${store}-wal`, `${store}-shm`, dirname(RETENTION_DIR)];
  if (config.build !== undefined) paths.push(relative(site, join(site, config.build.outDir)));
  const outside = paths.filter((path) => path === "" || path.startsWith("..") || isAbsolute(path));
  if (outside.length > 0) {
    throw new Error(
      `Config "${config.configPath}": the job keeps ${outside.map((path) => JSON.stringify(path)).join(", ")} between runs, and each must be inside the site directory — point "store" and "build.outDir" at paths under it`,
    );
  }
  return { store, paths };
}

function replace(paths: readonly string[], from: string, to: string): void {
  for (const path of paths) {
    rmSync(join(to, path), { recursive: true, force: true });
    if (existsSync(join(from, path))) cpSync(join(from, path), join(to, path), { recursive: true });
  }
}

function step(
  name: StepName,
  argv: readonly string[],
  cwd: string,
  options: PublishOptions,
): Promise<PublishStep> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      { cwd, env: options.env, timeout: options.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ name, argv, code, stdout, stderr });
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
  const { store, paths } = await retained(options.site);
  mkdirSync(options.state, { recursive: true });
  const incremental = existsSync(join(options.state, store));
  replace(paths, options.state, options.site);
  const flag = incremental ? ["--incremental"] : [];
  const plan: readonly { name: StepName; argv: readonly string[] }[] = [
    { name: "sync", argv: [options.pagedeck, "sync", ...flag] },
    { name: "build", argv: [options.pagedeck, "build", ...flag] },
    { name: "deploy", argv: [...options.deploy, "--apply", "--prune"] },
  ];
  const steps: PublishStep[] = [];
  for (const { name, argv } of plan) {
    const ran = await step(name, argv, options.site, options);
    steps.push(ran);
    if (ran.code !== 0) return { ok: false, failed: name, incremental, steps };
    await options.afterStep?.(name);
  }
  replace(paths, options.site, options.state);
  return { ok: true, incremental, steps };
}
