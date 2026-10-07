import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSystemErrorMap } from "node:util";
import {
  ConfigError,
  describeError,
  EXIT_CODES,
  listRetainedManifests,
  quoteIdentifier,
  readManifest,
  readRetainedManifest,
  RETENTION_DIR,
} from "@pagedeck/core";
import type { Manifest } from "@pagedeck/core";
import { compileRouting } from "@pagedeck/edge";
import type { EdgeOutput } from "@pagedeck/edge";
import { APPLY_FLAG, FORCE_FLAG, PRUNE_FLAG, runDeploy, runRollback } from "./deploy-run.js";
import type { UnreadableDeployInstant } from "./deploy-run.js";
import {
  HISTORY_INDEX_KEY,
  MANIFEST_KEY,
  deployInstantKey,
  readDeployInstant,
  retainedKey,
} from "./deploy-target.js";
import {
  DEPLOY_URLS_VARIABLE,
  originRead,
  readDeployUrls,
  readSignedHistory,
  readSignedIndex,
} from "./deploy-urls.js";
import type { DeployUrls } from "./deploy-urls.js";

const USAGE = [
  "Usage: node dist/deploy.bin.js --origin <dir> [--out <dir>] [--from <manifest>]",
  "                              [--staging <dir>] [--edge <target>]",
  "                              [--rollback <build-id>] [--apply] [--prune] [--force]",
  `       ${DEPLOY_URLS_VARIABLE}=<file> node dist/deploy.bin.js [--requests <file>] ...`,
  "",
  `Prints the deploy plan and writes nothing. Pass ${APPLY_FLAG} to upload it.`,
  `${DEPLOY_URLS_VARIABLE} names a file of presigned URLs, in place of --origin.`,
].join("\n");

function usageError(message: string): ConfigError {
  return new ConfigError([message, "", USAGE].join("\n"));
}

const VALUE_OPTIONS = [
  "--origin",
  "--out",
  "--from",
  "--staging",
  "--edge",
  "--rollback",
  "--requests",
] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

interface Args {
  origin?: string;
  out: string;
  from?: string;
  staging?: string;
  edge?: string;
  rollback?: string;
  requests?: string;
  signedUrls?: string;
  apply: boolean;
  prune: boolean;
  force: boolean;
}

// By inode as well as by path, so a link to the file is the file.
function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const one = statSync(a, { throwIfNoEntry: false });
  const two = statSync(b, { throwIfNoEntry: false });
  return one !== undefined && two !== undefined && one.dev === two.dev && one.ino === two.ino;
}

function parse(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  const args: Args = { out: "./site", apply: false, prune: false, force: false };
  const values = new Map<ValueOption, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === APPLY_FLAG) {
      args.apply = true;
      continue;
    }
    if (arg === PRUNE_FLAG) {
      args.prune = true;
      continue;
    }
    if (arg === FORCE_FLAG) {
      args.force = true;
      continue;
    }
    const option = VALUE_OPTIONS.find((one) => one === arg);
    if (option === undefined) throw usageError(`Unknown option ${quoteIdentifier(arg)}.`);
    const value = argv[index + 1];
    if (value === undefined) throw usageError(`Option "${option}" takes a value.`);
    index += 1;
    const already = values.get(option);
    if (already !== undefined) {
      throw usageError(
        `Option "${option}" is given twice, as ${quoteIdentifier(already)} and as ${quoteIdentifier(value)} — two sources for one value are refused rather than ranked; pass it once.`,
      );
    }
    values.set(option, value);
  }
  args.origin = values.get("--origin");
  args.out = values.get("--out") ?? args.out;
  args.from = values.get("--from");
  args.staging = values.get("--staging");
  args.edge = values.get("--edge");
  args.rollback = values.get("--rollback");
  args.requests = values.get("--requests");
  const signedUrls = env[DEPLOY_URLS_VARIABLE]?.trim();
  if (signedUrls !== undefined && signedUrls !== "") args.signedUrls = signedUrls;
  if (args.origin !== undefined && args.signedUrls !== undefined) {
    throw usageError(
      `Option "--origin" and ${DEPLOY_URLS_VARIABLE} are both given, as ${quoteIdentifier(args.origin)} and ${quoteIdentifier(args.signedUrls)} — two sources for one origin are refused rather than ranked; pass one.`,
    );
  }
  if (args.origin === undefined && args.signedUrls === undefined) {
    throw usageError(`No --origin given, and ${DEPLOY_URLS_VARIABLE} is not set.`);
  }
  if (args.requests !== undefined && args.apply) {
    throw usageError(
      `Options "--requests" and "${APPLY_FLAG}" are given together — --requests lists what a dry run would ask the signing step for, and an apply signs nothing; drop one.`,
    );
  }
  if (
    args.requests !== undefined &&
    args.signedUrls !== undefined &&
    sameFile(args.requests, args.signedUrls)
  ) {
    throw usageError(
      `Option "--requests" names ${quoteIdentifier(args.requests)}, which is the file ${DEPLOY_URLS_VARIABLE} names — the dry run would write the requests over the presigned URLs; write the requests to another file.`,
    );
  }
  if (args.requests !== undefined && args.signedUrls === undefined) {
    throw usageError(
      `Option "--requests" is given without ${DEPLOY_URLS_VARIABLE} — it lists the requests a presigned origin needs signed, and a directory origin needs none; set ${DEPLOY_URLS_VARIABLE}, or drop "--requests".`,
    );
  }
  if (args.rollback !== undefined && args.from !== undefined) {
    throw usageError(
      `Options "--rollback" and "--from" are given together, as ${quoteIdentifier(args.rollback)} and ${quoteIdentifier(args.from)} — a rollback deploys the retained build over what "--out" says is live, so there is no second source for that side; drop "--from", or drop "--rollback" to plan a deploy.`,
    );
  }
  return args;
}

// Only `ENOENT` is absent (#532): an unreadable manifest read as absent planned a
// first deploy over a live origin.
async function manifestAt(file: string): Promise<Manifest | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new ConfigError(
      `Manifest ${quoteIdentifier(file)}: could not be opened (${code ?? "no error code"}) — make it a file this deploy can read`,
      { cause },
    );
  }
  return readManifest(text, file);
}

// Nothing from inside a file reaches the reason, so bytes written at the origin
// never reach the plan.
async function deployInstantsAt(
  origin: string,
  published: readonly Manifest[],
): Promise<{
  deployedAt: ReadonlyMap<string, Date>;
  unreadableDeployInstants: readonly UnreadableDeployInstant[];
}> {
  const deployedAt = new Map<string, Date>();
  const unreadable: UnreadableDeployInstant[] = [];
  for (const id of new Set(published.map((manifest) => manifest.build.id))) {
    const key = deployInstantKey(id);
    let text: string;
    try {
      text = await readFile(join(origin, key.replace(/^\//, "")), "utf8");
    } catch (cause) {
      const { code, errno } = cause as NodeJS.ErrnoException;
      if (code === "ENOENT") continue;
      // The errno's own message, not `cause.message`, which repeats the path.
      const message = errno === undefined ? undefined : getSystemErrorMap().get(errno)?.[1];
      unreadable.push({
        key,
        reason: `it could not be opened (${code ?? "no error code"}${message === undefined ? "" : `: ${message}`})`,
      });
      continue;
    }
    const instant = readDeployInstant(text);
    if (instant === undefined) {
      unreadable.push({ key, reason: "it holds no ISO-8601 instant" });
    } else {
      deployedAt.set(id, instant);
    }
  }
  return { deployedAt, unreadableDeployInstants: unreadable };
}

// The build that ends up live: after a rollback, the host serves the restored
// build's redirects.
function edgeOf(manifest: Manifest, target: string | undefined): EdgeOutput | undefined {
  return target === undefined ? undefined : compileRouting(manifest.routing, { target });
}

async function signedManifest(urls: DeployUrls, key: string): Promise<Manifest | undefined> {
  const text = await originRead(urls, key);
  return text === undefined ? undefined : readManifest(text, `origin:${key}`);
}

// The history is found through the index the applies write, never by listing (#659).
async function mainSigned(
  args: Args,
  file: string,
  out: string,
  run: { source: string; staging?: string; apply: boolean; pruneAfterUpload: boolean; force: boolean },
  write: (line: string) => void,
): Promise<number> {
  const urls = await readDeployUrls(file);
  const requests = args.requests === undefined ? {} : { requests: resolve(process.cwd(), args.requests) };
  const current = await manifestAt(join(out, "manifest.json"));
  const origin = DEPLOY_URLS_VARIABLE;

  if (args.rollback !== undefined) {
    const id = args.rollback;
    if (current === undefined) {
      throw new ConfigError(
        `Rollback to build ${quoteIdentifier(id)}: there is no manifest at ${quoteIdentifier(join(out, "manifest.json"))}, so there is no tree to restore from — pass --out the tree build ${quoteIdentifier(id)} wrote`,
      );
    }
    if (current.build.id !== id) {
      throw new ConfigError(
        `Rollback to build ${quoteIdentifier(id)}: the tree at ${quoteIdentifier(out)} is build ${quoteIdentifier(current.build.id)}, and a rollback uploads the restored build's own bytes from that tree — pass --out the tree build ${quoteIdentifier(id)} wrote.`,
      );
    }
    const live = await signedManifest(urls, MANIFEST_KEY);
    if (live === undefined) {
      throw new ConfigError(
        `Rollback to build ${quoteIdentifier(id)}: the origin holds no ${quoteIdentifier(MANIFEST_KEY)}, so no build is live to roll back from — deploy the build without --rollback`,
      );
    }
    const index = await readSignedIndex(urls);
    const history = retainedKey(id);
    const retained = await signedManifest(urls, history);
    if (retained === undefined) {
      throw new ConfigError(
        `Rollback to build ${quoteIdentifier(id)}: the origin's deploy history holds no ${quoteIdentifier(history)}, so the origin never served that build — name a build the history holds`,
      );
    }
    const edge = edgeOf(retained, args.edge);
    return await runRollback(
      {
        current: live,
        retained,
        ...(edge === undefined ? {} : { edge }),
        ...run,
        origin,
        history: [...(index ?? []), live.build.id],
        presigned: { urls, reads: [MANIFEST_KEY, HISTORY_INDEX_KEY, history], ...requests },
      },
      write,
    );
  }

  if (current === undefined) {
    throw new ConfigError(
      `Deploy: there is no manifest at ${quoteIdentifier(join(out, "manifest.json"))} — run pagedeck build first, or pass --out`,
    );
  }
  const stated = args.from === undefined ? undefined : resolve(process.cwd(), args.from);
  let atOrigin: Manifest | undefined;
  if (stated === undefined) {
    atOrigin = await signedManifest(urls, MANIFEST_KEY);
  } else {
    atOrigin = await manifestAt(stated);
    if (atOrigin === undefined) {
      throw new ConfigError(
        `Deploy: there is no manifest at ${quoteIdentifier(stated)} — pass --from the manifest.json the live build wrote, or omit it to read the one the origin holds`,
      );
    }
  }
  const index = await readSignedIndex(urls);
  // Planned as a first deploy, its prune would time what the lost manifest served from
  // a stamp, with no grace.
  if (atOrigin === undefined && index !== undefined && index.length > 0) {
    const builds = index.length;
    throw new ConfigError(
      `Deploy: the origin holds no ${quoteIdentifier(MANIFEST_KEY)}, but its history index ${quoteIdentifier(HISTORY_INDEX_KEY)} names ${String(builds)} ${builds === 1 ? "build" : "builds"}, so the origin is damaged rather than new — put the document of the build it last served, ${quoteIdentifier(retainedKey("<build id>"))}, back at ${quoteIdentifier(MANIFEST_KEY)}, or pass --from a copy of it; that build is the one whose ${quoteIdentifier(deployInstantKey("<build id>"))} holds the newest instant`,
    );
  }
  // A manifest read off the origin was filed into its history by the apply that put it
  // there, so it joins an index that lost it, or one this apply starts.
  const read = stated === undefined && atOrigin !== undefined ? [atOrigin.build.id] : [];
  const signedHistory = run.pruneAfterUpload
    ? await readSignedHistory(urls, index, { listUnsigned: args.requests !== undefined })
    : undefined;
  const retention =
    signedHistory?.retention === undefined
      ? undefined
      : {
          live: current,
          ...(atOrigin === undefined ? {} : { wasLive: atOrigin }),
          ...signedHistory.retention,
        };
  const edge = edgeOf(current, args.edge);
  return await runDeploy(
    {
      ...(atOrigin === undefined ? {} : { from: atOrigin }),
      to: current,
      ...(edge === undefined ? {} : { edge }),
      ...run,
      origin,
      history: [...(index ?? []), ...read],
      ...(retention === undefined ? {} : { retention }),
      ...(signedHistory?.withheld === undefined ? {} : { pruneWithheld: signedHistory.withheld }),
      presigned: {
        urls,
        reads: [
          ...(stated === undefined ? [MANIFEST_KEY] : []),
          HISTORY_INDEX_KEY,
          ...(signedHistory?.reads ?? []),
        ],
        ...requests,
      },
    },
    write,
  );
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2), process.env);
  const cwd = process.cwd();
  const out = resolve(cwd, args.out);
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  if (args.signedUrls !== undefined) {
    return await mainSigned(
      args,
      resolve(cwd, args.signedUrls),
      out,
      {
        source: out,
        ...(args.staging === undefined ? {} : { staging: resolve(cwd, args.staging) }),
        apply: args.apply,
        pruneAfterUpload: args.prune,
        force: args.force,
      },
      write,
    );
  }
  const origin = resolve(cwd, args.origin as string);
  const run = {
    source: out,
    origin,
    ...(args.staging === undefined ? {} : { staging: resolve(cwd, args.staging) }),
    apply: args.apply,
    pruneAfterUpload: args.prune,
    force: args.force,
  };

  const current = await manifestAt(join(out, "manifest.json"));

  if (args.rollback !== undefined) {
    if (current === undefined) {
      throw new ConfigError(
        `Rollback to build ${quoteIdentifier(args.rollback)}: there is no manifest at ${quoteIdentifier(join(out, "manifest.json"))}, so there is nothing to roll back from — run pagedeck build first, or pass --out`,
      );
    }
    const retained = await readRetainedManifest(cwd, args.rollback);
    const edge = edgeOf(retained, args.edge);
    const history = (await listRetainedManifests(origin)).map((one) => one.build.id);
    return await runRollback(
      { current, retained, ...(edge === undefined ? {} : { edge }), ...run, history },
      write,
    );
  }

  if (current === undefined) {
    throw new ConfigError(
      `Deploy: there is no manifest at ${quoteIdentifier(join(out, "manifest.json"))} — run pagedeck build first, or pass --out`,
    );
  }
  const stated = args.from === undefined ? undefined : resolve(cwd, args.from);
  const originManifest = join(origin, MANIFEST_KEY.replace(/^\//, ""));
  const atOrigin = await manifestAt(stated ?? originManifest);
  if (stated !== undefined && atOrigin === undefined) {
    throw new ConfigError(
      `Deploy: there is no manifest at ${quoteIdentifier(stated)} — pass --from the manifest.json the live build wrote, or omit it to read the one the origin holds`,
    );
  }
  const edge = edgeOf(current, args.edge);
  // Not this runner's own store: builds made locally never served, and blaming one
  // deletes a live chunk (#287).
  const published = await listRetainedManifests(origin);
  // No manifest is a first deploy only while the history is empty too (#561):
  // otherwise the prune could delete what the origin served a second ago.
  const instants = await deployInstantsAt(origin, published);
  if (atOrigin === undefined && published.length > 0) {
    const builds = published.length;
    const history = join(origin, RETENTION_DIR);
    const served =
      instants.unreadableDeployInstants.length > 0
        ? undefined
        : [...instants.deployedAt].sort(([, a], [, b]) => b.getTime() - a.getTime())[0]?.[0];
    if (served === undefined) {
      throw new ConfigError(
        `Deploy: there is no manifest at ${quoteIdentifier(originManifest)}, but the origin's deploy history at ${quoteIdentifier(history)} holds ${String(builds)} ${builds === 1 ? "build" : "builds"}, so the origin is damaged rather than new; the deploy instants there do not say which build the origin serves — copy the history file the last apply's "Filed this build" line names to ${quoteIdentifier(originManifest)}, or pass --from that file`,
      );
    }
    const document = join(origin, retainedKey(served).replace(/^\//, ""));
    throw new ConfigError(
      `Deploy: there is no manifest at ${quoteIdentifier(originManifest)}, but the origin's deploy history at ${quoteIdentifier(history)} holds ${String(builds)} ${builds === 1 ? "build" : "builds"}, so the origin is damaged rather than new; build ${quoteIdentifier(served)} has the newest deploy instant there, so it is the build the origin last served — copy ${quoteIdentifier(document)} to ${quoteIdentifier(originManifest)}, or pass --from ${quoteIdentifier(document)}`,
    );
  }
  const retention = {
    live: current,
    ...(atOrigin === undefined ? {} : { wasLive: atOrigin }),
    published,
    ...instants,
  };
  return await runDeploy(
    {
      ...(atOrigin === undefined ? {} : { from: atOrigin }),
      to: current,
      ...(edge === undefined ? {} : { edge }),
      ...run,
      history: published.map((one) => one.build.id),
      retention,
    },
    write,
  );
}

try {
  process.exitCode = await main();
} catch (error) {
  // This executable's one stderr write: rule 8 binds a build process, and this is a
  // separate executable with no `CliIo`.
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode =
    error instanceof ConfigError ? EXIT_CODES.configError : EXIT_CODES.syncFailed;
}
