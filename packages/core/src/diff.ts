import { ConfigError } from "./exit.js";
import { fileKey } from "./manifest.js";
import type {
  BuildStamp,
  FileKind,
  Manifest,
  ManifestFile,
} from "./manifest.js";
import { quoteIdentifier } from "./quote.js";

export const DIFF_VERSION = 1;

export type FileChange = "added" | "changed";

export interface DiffFile {
  key: string;
  path: string;
  kind: FileKind;
  change: FileChange;
  hash: string;
  size: number;
  previousHash?: string;
  hashed?: true;
}

export interface PrunedFile {
  key: string;
  path: string;
  kind: FileKind;
  hash: string;
  size: number;
}

export interface PrunePolicy {
  graceSeconds: number;
}

export const DEFAULT_PRUNE_POLICY: PrunePolicy = { graceSeconds: 604_800 };

export interface PruneWindow {
  graceSeconds: number;
  after: string;
  notBefore: string;
}

export interface DiffTree {
  domain?: string;
  upload: readonly DiffFile[];
  prune: readonly PrunedFile[];
}

export interface DiffStats {
  added: number;
  changed: number;
  pruned: number;
  unchanged: number;
  uploadBytes: number;
  prunedBytes: number;
}

export interface ManifestDiff {
  version: number;
  from: BuildStamp;
  to: BuildStamp;
  prune: PruneWindow;
  trees: readonly DiffTree[];
  stats: DiffStats;
}

export interface DiffInput {
  from: Manifest;
  to: Manifest;
  prune?: PrunePolicy;
}

type Side = "from" | "to";

function indexFiles(
  manifest: Manifest,
  side: Side,
  duplicates: string[],
): Map<string, ManifestFile> {
  const byKey = new Map<string, ManifestFile>();
  for (const file of manifest.files) {
    const key = fileKey(file.domain, file.path);
    if (byKey.has(key)) duplicates.push(`  "${key}" — in the ${side} manifest`);
    else byKey.set(key, file);
  }
  return byKey;
}

function duplicateKeyReport(duplicates: readonly string[]): string {
  const count = duplicates.length;
  const subject =
    count === 1
      ? "1 deploy key is held twice by a manifest"
      : `${String(count)} deploy keys are held twice by a manifest`;
  return `Manifest diff: ${subject} — a diff joins two manifests on this key, so re-run the build that wrote it rather than editing the document by hand:\n${[...duplicates].sort().join("\n")}`;
}

function treeKey(domain: string | undefined): string {
  return domain ?? "";
}

interface TreeRows {
  assets: DiffFile[];
  html: DiffFile[];
  prune: PrunedFile[];
}

/**
 * `Z` or an offset is required: `Date.parse` reads an offset-less time in the
 * machine's zone.
 */
const UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

function pruneWindow(to: BuildStamp, policy: PrunePolicy): PruneWindow {
  const after = Date.parse(to.createdAt);
  if (Number.isNaN(after)) {
    throw new Error(
      `Manifest diff: the to manifest's build.createdAt is "${to.createdAt}", which is not a date the prune deadline can be derived from — pagedeck build writes an ISO-8601 timestamp, so re-run the build that wrote this manifest`,
    );
  }
  if (!UTC_OFFSET.test(to.createdAt)) {
    throw new Error(
      `Manifest diff: the to manifest's build.createdAt is "${to.createdAt}", which carries no UTC offset, so the prune deadline it derives would move with the machine's timezone — pagedeck build writes an ISO-8601 timestamp in UTC, so re-run the build that wrote this manifest`,
    );
  }
  const deadline = new Date(after + policy.graceSeconds * 1000);
  if (Number.isNaN(deadline.getTime())) {
    throw new ConfigError(
      `Manifest diff: a grace period of ${String(policy.graceSeconds)} seconds past "${to.createdAt}" is not a deadline any date can hold — pass a smaller --grace-seconds (the default is ${String(DEFAULT_PRUNE_POLICY.graceSeconds)}, seven days)`,
    );
  }
  return {
    graceSeconds: policy.graceSeconds,
    after: to.createdAt,
    notBefore: deadline.toISOString(),
  };
}

export function diffManifests(input: DiffInput): ManifestDiff {
  const policy = input.prune ?? DEFAULT_PRUNE_POLICY;
  const duplicates: string[] = [];
  const before = indexFiles(input.from, "from", duplicates);
  const after = indexFiles(input.to, "to", duplicates);
  if (duplicates.length > 0) throw new Error(duplicateKeyReport(duplicates));

  const prune = pruneWindow(input.to.build, policy);

  // Seeded from both builds, so a market dropped since `from` still gets its
  // prune rows; sorted, because `readManifest` does not check file order.
  const rows = new Map<string, TreeRows>();
  for (const file of [...input.from.files, ...input.to.files]) {
    const key = treeKey(file.domain);
    if (!rows.has(key)) rows.set(key, { assets: [], html: [], prune: [] });
  }
  const trees = [...rows.keys()].sort();
  const rowsOf = (domain: string | undefined): TreeRows =>
    rows.get(treeKey(domain)) as TreeRows;

  const stats: DiffStats = {
    added: 0,
    changed: 0,
    pruned: 0,
    unchanged: 0,
    uploadBytes: 0,
    prunedBytes: 0,
  };

  for (const file of input.to.files) {
    const key = fileKey(file.domain, file.path);
    const previous = before.get(key);
    if (previous?.hash === file.hash) {
      stats.unchanged += 1;
      continue;
    }
    const row: DiffFile = {
      key,
      path: file.path,
      kind: file.kind,
      change: previous === undefined ? "added" : "changed",
      hash: file.hash,
      size: file.size,
      ...(previous === undefined ? {} : { previousHash: previous.hash }),
      ...(file.hashed === true ? { hashed: true as const } : {}),
    };
    if (row.change === "added") stats.added += 1;
    else stats.changed += 1;
    stats.uploadBytes += file.size;
    const tree = rowsOf(file.domain);
    if (file.kind === "html") tree.html.push(row);
    else tree.assets.push(row);
  }

  for (const file of input.from.files) {
    const key = fileKey(file.domain, file.path);
    if (after.has(key)) continue;
    rowsOf(file.domain).prune.push({
      key,
      path: file.path,
      kind: file.kind,
      hash: file.hash,
      size: file.size,
    });
    stats.pruned += 1;
    stats.prunedBytes += file.size;
  }

  return {
    version: DIFF_VERSION,
    from: input.from.build,
    to: input.to.build,
    prune,
    trees: trees.map((domain) => {
      const tree = rowsOf(domain);
      return {
        ...(domain === "" ? {} : { domain }),
        upload: [...tree.assets, ...tree.html],
        prune: tree.prune,
      };
    }),
    stats,
  };
}

export function racedDeployReport(diff: ManifestDiff): string | undefined {
  const writes = diff.trees.some(
    (tree) => tree.upload.length > 0 || tree.prune.length > 0,
  );
  if (!writes) return undefined;
  const parent = diff.to.parent;
  if (parent === diff.from.id) return undefined;
  if (parent === undefined) {
    return `Manifest diff: build ${quoteIdentifier(diff.to.id)} records no parent, so nothing in it says it was built on build ${quoteIdentifier(diff.from.id)} — a build records the newest manifest its retention store held when it started, and one that ran before the store existed records none; re-run pagedeck build so it records this base, or pass --force to deploy it anyway`;
  }
  return `Manifest diff: build ${quoteIdentifier(diff.to.id)} was built on ${quoteIdentifier(parent)} and is being deployed over build ${quoteIdentifier(diff.from.id)}, so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy`;
}

/**
 * Keys written out, not copied from `build`: the key order is this document's
 * contract.
 */
function stamp(build: BuildStamp): unknown {
  return {
    id: build.id,
    createdAt: build.createdAt,
    ...(build.parent === undefined ? {} : { parent: build.parent }),
  };
}

/**
 * `forced` sits second, beside `version`, on purpose: both describe the
 * document (#560).
 */
function ordered(diff: ManifestDiff, forced: boolean): unknown {
  return {
    version: diff.version,
    ...(forced ? { forced: true } : {}),
    from: stamp(diff.from),
    to: stamp(diff.to),
    prune: {
      graceSeconds: diff.prune.graceSeconds,
      after: diff.prune.after,
      notBefore: diff.prune.notBefore,
    },
    trees: diff.trees.map((tree) => ({
      ...(tree.domain === undefined ? {} : { domain: tree.domain }),
      upload: tree.upload.map((file) => ({
        key: file.key,
        path: file.path,
        kind: file.kind,
        change: file.change,
        hash: file.hash,
        size: file.size,
        ...(file.previousHash === undefined
          ? {}
          : { previousHash: file.previousHash }),
        ...(file.hashed === true ? { hashed: true } : {}),
      })),
      prune: tree.prune.map((file) => ({
        key: file.key,
        path: file.path,
        kind: file.kind,
        hash: file.hash,
        size: file.size,
      })),
    })),
    stats: {
      added: diff.stats.added,
      changed: diff.stats.changed,
      pruned: diff.stats.pruned,
      unchanged: diff.stats.unchanged,
      uploadBytes: diff.stats.uploadBytes,
      prunedBytes: diff.stats.prunedBytes,
    },
  };
}

export function diffJson(
  diff: ManifestDiff,
  emission: { forced?: boolean } = {},
): string {
  return `${JSON.stringify(ordered(diff, emission.forced === true), null, 2)}\n`;
}
