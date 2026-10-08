import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CollectionError } from "@pagedeck/content";
import {
  installRegistryWarnings,
  RegistryError,
  StoreError,
} from "@pagedeck/islands";
import { loadConfig, outputDir } from "./config.js";
import {
  DEFAULT_PRUNE_POLICY,
  diffJson,
  diffManifests,
  racedDeployReport,
} from "./diff.js";
import type { PrunePolicy } from "./diff.js";
import { ConfigError, describeError, EXIT_CODES } from "./exit.js";
import type { ExitCode } from "./exit.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { quoteIdentifier } from "./quote.js";
import { listRetainedManifests, readRetainedManifest } from "./retention.js";
import { pullSnapshot, pushSnapshot, redactTarget } from "./snapshot.js";
import { syncSite } from "./sync.js";
import type { SyncOptions, SyncReport } from "./sync.js";
import { trackSiteModules } from "./site-modules.js";
import { rest, watchSync } from "./watch.js";

export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  out(line: string): void;
  err(line: string): void;
}

const SNAPSHOT_URL_VARIABLES = {
  pull: "PAGEDECK_SNAPSHOT_PULL_URL",
  push: "PAGEDECK_SNAPSHOT_PUSH_URL",
} as const;

const USAGE = [
  "Usage:",
  "  pagedeck build [--incremental]                render, bundle and write the whole site",
  "  pagedeck dev [--port <n>] [--host <addr>]     serve the site from the store, rendering on request",
  "  pagedeck sync [--incremental]                 sync every configured collection",
  "  pagedeck sync --watch                         sync again every --interval seconds, until stopped",
  "  pagedeck store pull [<url>]                   fetch the store snapshot from <url>",
  "  pagedeck store push [<url>]                   upload the store snapshot to <url>",
  "  pagedeck diff <from> <to>                     compare two manifests, in upload order",
  "  pagedeck rollback <build-id>                  restore a retained build, in upload order",
  "",
  "pagedeck sync --watch runs until it is stopped, syncing every --interval <seconds>",
  "(default 5). It composes with --incremental rather than implying it: --watch",
  "alone runs full syncs, and --incremental --watch runs incremental ones.",
  "pagedeck diff and pagedeck rollback take --grace-seconds <n> to set how long a pruned file stays reachable.",
  "pagedeck diff takes --force to deploy a build that was not based on the build it is",
  "deploying over. pagedeck rollback needs no such flag: a rollback is out of order by",
  "definition, which is the whole of what it is for.",
  "<url> is a file: or https: URL (an S3-style target is a presigned https: URL).",
  "When the command line names no <url>, pagedeck store pull takes it from",
  "PAGEDECK_SNAPSHOT_PULL_URL and pagedeck store push from PAGEDECK_SNAPSHOT_PUSH_URL:",
  "a presigned URL is signed for one method, so each verb has its own.",
  "Naming no <url> is what keeps a presigned one out of the process table and",
  "the echoed CI line. Giving both is refused.",
];

function isWiringFault(error: unknown): boolean {
  return (
    error instanceof ConfigError ||
    error instanceof RegistryError ||
    error instanceof StoreError ||
    error instanceof CollectionError
  );
}

const DEFAULT_DEV_PORT = 5173;

function usageError(message: string): ConfigError {
  return new ConfigError([message, "", ...USAGE].join("\n"));
}

const DEFAULT_WATCH_INTERVAL_SECONDS = 5;

/**
 * `setTimeout`'s signed 32-bit millisecond range: Node turns a longer delay
 * into 1 ms, so a longer interval is refused rather than clamped.
 */
const MAX_WATCH_INTERVAL_SECONDS = 2147483;

export interface SyncArgs extends SyncOptions {
  readonly watch: boolean;
  readonly intervalMs: number;
}

export function parseSyncArgs(args: readonly string[]): SyncArgs {
  let incremental = false;
  let watch = false;
  let intervalSeconds: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--incremental") {
      incremental = true;
      continue;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg === "--interval") {
      index += 1;
      const value = args[index];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) === 0) {
        throw usageError(
          `pagedeck sync --interval takes a whole number of seconds above zero, and got ${
            value === undefined ? "nothing" : quoteIdentifier(value)
          }.`,
        );
      }
      if (Number(value) > MAX_WATCH_INTERVAL_SECONDS) {
        throw usageError(
          `pagedeck sync --interval takes at most ${String(
            MAX_WATCH_INTERVAL_SECONDS,
          )} seconds, the longest rest a JavaScript timer holds, and got ${quoteIdentifier(value)} — Node clamps a longer delay to 1ms, which is the sync loop with no rest in it that this flag refuses zero to prevent.`,
        );
      }
      intervalSeconds = Number(value);
      continue;
    }
    throw usageError(`Unknown option ${quoteIdentifier(arg)} for pagedeck sync.`);
  }

  if (intervalSeconds !== undefined && !watch) {
    throw usageError(
      "pagedeck sync --interval sets how long a watch rests between syncs, and this run has no watch — add --watch, or drop --interval.",
    );
  }
  return {
    incremental,
    watch,
    intervalMs: (intervalSeconds ?? DEFAULT_WATCH_INTERVAL_SECONDS) * 1000,
  };
}

function parseBuildArgs(args: readonly string[]): { incremental: boolean } {
  let incremental = false;
  for (const arg of args) {
    if (arg === "--incremental") {
      incremental = true;
      continue;
    }
    throw usageError(`Unknown option ${quoteIdentifier(arg)} for pagedeck build.`);
  }
  return { incremental };
}

/**
 * `./build.js` is imported inside the verb: it imports the bundler, and this
 * module is re-exported from the package index.
 */
async function runBuildVerb(
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const { incremental } = parseBuildArgs(args);
  const config = await loadConfig(io.cwd);
  const { buildSite } = await import("./build.js");
  const [base] = await listRetainedManifests(dirname(config.configPath));
  const built = await buildSite({
    config,
    ...(incremental ? { incremental: true } : {}),
    stamp: {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(base === undefined ? {} : { parent: base.build.id }),
    },
  });
  for (const warning of built.warnings) io.err(warning);
  io.out(
    `built ${String(built.pages.length)} pages, ${String(built.files.length)} files to ${built.outDir}`,
  );
  const preview = config.build?.preview;
  if (preview !== undefined) {
    io.out(
      `preview: ${preview.path} — this app authenticates nothing and renders any draft posted to it; put the deployment behind whatever the drafts need (Pagedeck documentation: Preview app, Security)`,
    );
  }
  if (built.patch !== undefined) {
    const { total, rendered, reused, removed } = built.patch.stats;
    const whole = built.patch.wholeIndex;
    const widened =
      whole === undefined
        ? ""
        : whole.kind === "unpatched-index"
          ? ` — every page, because the ${JSON.stringify(whole.adapter)} search adapter has no patch and its index is composed from every page's render`
          : ` — every page, because the previous build holds no index from the ${JSON.stringify(whole.adapter)} search adapter to patch`;
    io.out(
      `incremental: ${String(rendered)} of ${String(total)} pages rendered, ${String(reused)} reused, ${String(removed)} removed${widened}`,
    );
  }
  return EXIT_CODES.success;
}

export function parseDevArgs(args: readonly string[]): {
  port: number;
  host: string | undefined;
} {
  let port = DEFAULT_DEV_PORT;
  let host: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--host") {
      index += 1;
      const value = args[index];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw usageError(
          `pagedeck dev --host takes the address to bind — 127.0.0.1 for this machine only, 0.0.0.0 for every interface — and got ${
            value === undefined ? "nothing" : quoteIdentifier(value)
          }.`,
        );
      }
      // Unwrapped: `listen` resolves "[::]" as a name and binds nothing.
      host = value.startsWith("[") && value.endsWith("]")
        ? value.slice(1, -1)
        : value;
      continue;
    }
    if (arg !== "--port") {
      throw usageError(`Unknown option ${quoteIdentifier(arg)} for pagedeck dev.`);
    }
    index += 1;
    const value = args[index];
    if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) {
      throw usageError(
        `pagedeck dev --port takes a port between 0 and 65535, and got ${
          value === undefined ? "nothing" : quoteIdentifier(value)
        }.`,
      );
    }
    port = Number(value);
  }
  return { port, host };
}

export function lanAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => !address.internal && address.family === "IPv4")
    .map((address) => address.address);
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

const LOOPBACK_HOSTS = new Set(["localhost", "::1"]);

export function devServingLines(
  configPath: string,
  server: { readonly url: string; readonly port: number },
  host: string | undefined,
  addresses: readonly string[] = lanAddresses(),
): readonly string[] {
  const lines = [`serving ${configPath} at ${server.url}`];
  if (host === undefined || LOOPBACK_HOSTS.has(host) || host.startsWith("127."))
    return lines;
  if (WILDCARD_HOSTS.has(host)) {
    const reachable = addresses[0];
    if (reachable !== undefined)
      lines.push(
        `  reachable on this network at http://${reachable}:${String(server.port)}`,
      );
  }
  lines.push(
    "  this server authenticates nothing and serves from the project root",
  );
  return lines;
}

/**
 * `./dev.js` is imported inside the verb: it imports the bundler, and this
 * module is re-exported from the package index.
 */
async function runDevVerb(
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const { port, host } = parseDevArgs(args);
  const modules = trackSiteModules(io.cwd);
  try {
    const config = await loadConfig(io.cwd);
    const { startDevServer } = await import("./dev.js");
    const server = await startDevServer({
      config,
      modules,
      port,
      host,
      err: (line) => {
        io.err(line);
      },
    });
    for (const line of devServingLines(config.configPath, server, host))
      io.out(line);
    await server.closed;
    return EXIT_CODES.success;
  } finally {
    modules.close();
  }
}

function reportSync(report: SyncReport, io: CliIo): ExitCode {
  for (const collection of report.synced) {
    io.out(
      `${collection.collection}: ${collection.changed} changed, ${collection.deleted} deleted, cursor ${collection.cursor}`,
    );
  }
  for (const warning of report.warnings) io.err(warning);
  for (const failure of report.failed) io.err(describeError(failure.error));
  if (report.failed.length === 0) return EXIT_CODES.success;
  return report.failed.some((failure) => isWiringFault(failure.error))
    ? EXIT_CODES.configError
    : EXIT_CODES.syncFailed;
}

async function runSyncVerb(
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const { watch, intervalMs, ...options } = parseSyncArgs(args);
  const config = await loadConfig(io.cwd);
  if (!watch) return reportSync(await syncSite(config, options), io);

  await watchSync({
    intervalMs,
    signal: new AbortController().signal,
    tick: async () => {
      reportSync(await syncSite(config, options), io);
    },
    onFailure: (error) => {
      io.err(describeError(error));
    },
    sleep: rest,
  });
  return EXIT_CODES.success;
}

function resolveSnapshotTarget(
  subcommand: "pull" | "push",
  url: string | undefined,
  env: CliIo["env"],
): string {
  const variable = SNAPSHOT_URL_VARIABLES[subcommand];
  const configured = env[variable]?.trim();
  const fromEnv = configured === "" ? undefined : configured;
  if (url !== undefined && fromEnv !== undefined) {
    throw usageError(
      `pagedeck store ${subcommand} was given a target twice: <url> is ${quoteIdentifier(redactTarget(url))} and ${variable} is ${quoteIdentifier(redactTarget(fromEnv))} — pass <url>, or unset ${variable}.`,
    );
  }
  const target = url ?? fromEnv;
  if (target === undefined) {
    throw usageError(
      `pagedeck store ${subcommand} needs a <url> to ${subcommand}, or ${variable} set to one.`,
    );
  }
  return target;
}

async function runStoreVerb(
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const [subcommand, url, ...rest] = args;
  if (subcommand === undefined) {
    throw usageError("pagedeck store needs a subcommand: pull or push.");
  }
  if (subcommand !== "pull" && subcommand !== "push") {
    throw usageError(
      `Unknown command ${quoteIdentifier(`pagedeck store ${subcommand}`)}.`,
    );
  }
  if (rest.length > 0) {
    throw usageError(
      `pagedeck store ${subcommand} takes one <url>, but got ${String(rest.length + 1)}.`,
    );
  }
  const target = resolveSnapshotTarget(subcommand, url, io.env);

  const config = await loadConfig(io.cwd);
  if (subcommand === "pull") {
    await pullSnapshot(target, config.storePath);
    io.out(
      `pulled snapshot from ${redactTarget(target)} to ${config.storePath}`,
    );
  } else {
    await pushSnapshot(config.storePath, target);
    io.out(
      `pushed snapshot from ${config.storePath} to ${redactTarget(target)}`,
    );
  }
  return EXIT_CODES.success;
}

interface DiffArgs {
  from: string;
  to: string;
  prune: PrunePolicy;
  force: boolean;
}

function parseDiffArgs(args: readonly string[]): DiffArgs {
  const faults: string[] = [];
  const paths: string[] = [];
  let graceSeconds = DEFAULT_PRUNE_POLICY.graceSeconds;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--grace-seconds") {
      index += 1;
      const value = args[index];
      // No upper bound here: only `pruneWindow` holds the `createdAt` it is
      // added to.
      if (value === undefined || !/^\d+$/.test(value)) {
        faults.push(
          `pagedeck diff --grace-seconds takes a whole number of seconds, and got ${
            value === undefined ? "nothing" : quoteIdentifier(value)
          }.`,
        );
      } else graceSeconds = Number(value);
      continue;
    }
    if (arg.startsWith("--")) {
      faults.push(`Unknown option ${quoteIdentifier(arg)} for pagedeck diff.`);
      continue;
    }
    paths.push(arg);
  }

  if (paths.length !== 2) {
    faults.push(
      `pagedeck diff takes two manifest paths — the build to deploy from, then the build to deploy — and got ${String(paths.length)}.`,
    );
  }
  if (faults.length > 0) throw usageError(faults.join("\n"));
  return {
    from: paths[0] as string,
    to: paths[1] as string,
    prune: { graceSeconds },
    force,
  };
}

interface LoadAttempt {
  path: string;
  manifest?: Manifest;
  error?: unknown;
}

async function loadAttempt(path: string): Promise<LoadAttempt> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return {
      path,
      error: new ConfigError(
        `Manifest ${quoteIdentifier(path)}: could not be read — pass the path pagedeck build wrote it to`,
        { cause },
      ),
    };
  }
  try {
    return { path, manifest: readManifest(text, path) };
  } catch (error) {
    return { path, error };
  }
}

async function readManifests(
  cwd: string,
  args: DiffArgs,
): Promise<{ from: Manifest; to: Manifest }> {
  const attempts = await Promise.all(
    [args.from, args.to].map((path) => loadAttempt(resolve(cwd, path))),
  );
  const failed = attempts.filter((attempt) => attempt.manifest === undefined);
  if (failed.length === 1) throw (failed[0] as LoadAttempt).error;
  if (failed.length > 1) {
    throw new ConfigError(
      `Manifest diff: ${String(failed.length)} manifests could not be loaded — pass the paths pagedeck build wrote them to:\n${failed
        .map((attempt) => `  ${describeError(attempt.error)}`)
        .join("\n")}`,
    );
  }
  const [from, to] = attempts as [LoadAttempt, LoadAttempt];
  return { from: from.manifest as Manifest, to: to.manifest as Manifest };
}

function writeDiff(io: CliIo, document: string): void {
  for (const line of document.trimEnd().split("\n")) io.out(line);
}

async function runDiffVerb(
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const parsed = parseDiffArgs(args);
  const { from, to } = await readManifests(io.cwd, parsed);
  const diff = diffManifests({ from, to, prune: parsed.prune });
  if (!parsed.force) {
    const raced = racedDeployReport(diff);
    if (raced !== undefined) throw new ConfigError(raced);
  }
  writeDiff(io, diffJson(diff, { forced: parsed.force }));
  return EXIT_CODES.success;
}

interface RollbackArgs {
  id?: string;
  prune: PrunePolicy;
  faults: readonly string[];
}

const ROLLBACK_TARGET_FIX =
  "pagedeck rollback takes one <build-id> — the build to restore, as pagedeck build retained it";
const ROLLBACK_TARGET_HINT =
  'A retained build\'s document is named after its id, and the id is the "build.id" in the manifest that build wrote.';

function parseRollbackArgs(args: readonly string[]): RollbackArgs {
  const faults: string[] = [];
  const ids: string[] = [];
  let graceSeconds = DEFAULT_PRUNE_POLICY.graceSeconds;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--grace-seconds") {
      index += 1;
      const value = args[index];
      if (value === undefined || !/^\d+$/.test(value)) {
        faults.push(
          `pagedeck rollback --grace-seconds takes a whole number of seconds, and got ${
            value === undefined ? "nothing" : quoteIdentifier(value)
          }.`,
        );
      } else graceSeconds = Number(value);
      continue;
    }
    if (arg.startsWith("--")) {
      faults.push(`Unknown option ${quoteIdentifier(arg)} for pagedeck rollback.`);
      continue;
    }
    ids.push(arg);
  }

  if (ids.length !== 1) {
    faults.push(
      `${ROLLBACK_TARGET_FIX} — and got ${String(ids.length)}. ${ROLLBACK_TARGET_HINT}`,
    );
  }
  return {
    ...(ids.length === 1 ? { id: ids[0] as string } : {}),
    prune: { graceSeconds },
    faults,
  };
}

async function retainedAttempt(
  root: string,
  id: string,
): Promise<LoadAttempt> {
  try {
    return { path: id, manifest: await readRetainedManifest(root, id) };
  } catch (error) {
    return { path: id, error };
  }
}

const NO_BUILD_SECTION_FIX =
  "add a build section to pagedeck.config.ts — build: { pages, components, content }";

async function runRollbackVerb(
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const { id, prune, faults } = parseRollbackArgs(args);
  if (id === undefined) throw usageError(faults.join("\n"));

  const config = await loadConfig(io.cwd);
  const section = config.build;
  if (section === undefined) {
    throw new ConfigError(
      `Config "${config.configPath}": declares no build section, so pagedeck rollback has no outDir to find the current manifest in — ${NO_BUILD_SECTION_FIX}`,
    );
  }
  const root = dirname(config.configPath);

  const [current, retained] = await Promise.all([
    loadAttempt(join(outputDir(config.configPath, section), MANIFEST_FILE)),
    retainedAttempt(root, id),
  ]);
  const failed = [current, retained].filter(
    (attempt) => attempt.manifest === undefined,
  );
  if (faults.length === 0 && failed.length === 1) {
    throw (failed[0] as LoadAttempt).error;
  }
  if (faults.length > 0 || failed.length > 0) {
    const lines = [
      ...faults,
      ...failed.map((attempt) => describeError(attempt.error)),
    ];
    throw new ConfigError(
      `Rollback to build ${quoteIdentifier(id)}: ${String(lines.length)} things stopped this run — each line names its own fix:\n${lines
        .map((line) => `  ${line}`)
        .join("\n")}`,
    );
  }

  writeDiff(
    io,
    diffJson(
      diffManifests({
        from: current.manifest as Manifest,
        to: retained.manifest as Manifest,
        prune,
      }),
    ),
  );
  return EXIT_CODES.success;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const [verb, ...args] = argv;
  const restoreWarnings = installRegistryWarnings((message) => {
    io.err(message);
  });
  try {
    if (verb === "build") return await runBuildVerb(args, io);
    if (verb === "dev") return await runDevVerb(args, io);
    if (verb === "sync") return await runSyncVerb(args, io);
    if (verb === "store") return await runStoreVerb(args, io);
    if (verb === "diff") return await runDiffVerb(args, io);
    if (verb === "rollback") return await runRollbackVerb(args, io);
    throw usageError(
      verb === undefined
        ? "No command given."
        : `Unknown command ${quoteIdentifier(verb)}.`,
    );
  } catch (error) {
    io.err(describeError(error));
    return isWiringFault(error)
      ? EXIT_CODES.configError
      : EXIT_CODES.syncFailed;
  } finally {
    restoreWarnings();
  }
}
