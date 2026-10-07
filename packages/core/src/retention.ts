import {
  constants,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { ConfigError, describeError, printable } from "./exit.js";
import { manifestJson, readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { quoteIdentifier } from "./quote.js";

export interface RetentionPolicy {
  keep: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { keep: 20 };

export const RETENTION_DIR = ".pagedeck/manifests";

const ID_FIX = "mint the build id as a name a path can hold, such as a uuid";

export function unusableId(id: string): string | undefined {
  if (id === "") {
    return "the build id is empty, so it names the retention store's own directory rather than a document in it";
  }
  if (id === "." || id === "..") {
    return "the build id is a dot segment, which resolves out of the retention store";
  }
  if (id.includes("/")) {
    return 'the build id holds "/", which would place the document in another directory';
  }
  if (id.includes("\\")) {
    return 'the build id holds "\\", which is a path separator on Windows and would place the document in another directory there';
  }
  if (id.startsWith(".")) {
    return "the build id starts with a dot, which is a dot segment or a hidden file rather than a name the store lists as a build";
  }
  return undefined;
}

function assertUsableId(id: string): void {
  const reason = unusableId(id);
  if (reason === undefined) return;
  throw new ConfigError(
    `Retained manifest ${quoteIdentifier(id)}: ${reason}, and each retained build is written to "<build id>.json" — ${ID_FIX}`,
  );
}

const SHAPE_FIX =
  '"build.retention" must be an object with a keep count — retention: { keep: 10 }';
const KEEP_FIX =
  "write a whole number of builds, 1 or more, such as retention: { keep: 10 }";
const UNKNOWN_KEY_FIX =
  'delete the field, or correct it to "keep", the only field retention takes';

function keepFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and the store keeps whole manifests";
  }
  if (value < 1) {
    return "below one, and a build reads the newest document in the store to record as its own parent, so a site that retains nothing cannot detect a raced deploy either";
  }
  return undefined;
}

export function retentionFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null) {
    return `${where}: ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];
  const keep = Object.hasOwn(record, "keep") ? record["keep"] : undefined;
  const reason = keepFault(keep);
  if (reason !== undefined) {
    sections.push(
      `${where}: "build.retention" is not a count of manifests to keep — ${KEEP_FIX}:\n  ${JSON.stringify(keep)} — ${reason}`,
    );
  }
  const unknown = Object.keys(record)
    .filter((key) => key !== "keep")
    .sort();
  if (unknown.length > 0) {
    const subject =
      unknown.length === 1
        ? "1 field this build does not read"
        : `${String(unknown.length)} fields this build does not read`;
    sections.push(
      `${where}: "build.retention" declares ${subject} — ${UNKNOWN_KEY_FIX}:\n${unknown
        .map((key) => `  "${key}"`)
        .join("\n")}`,
    );
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function storeDir(root: string): string {
  return join(root, RETENTION_DIR);
}

function fileNameOf(id: string): string {
  return `${id}.json`;
}

function fileOf(root: string, id: string): string {
  return join(storeDir(root), fileNameOf(id));
}

/**
 * Only a missing directory reads as empty: an unreadable store answering empty
 * would record no parent, and the next deploy would accept a race.
 */
async function retainedFiles(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(storeDir(root)))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

/**
 * Code-unit order, not `Date.parse`: chronological over `toISOString`, and
 * still total over a `createdAt` that does not parse.
 */
function newestFirst(a: HeldManifest, b: HeldManifest): number {
  const first = a.manifest.build;
  const second = b.manifest.build;
  if (first.createdAt !== second.createdAt) {
    return first.createdAt < second.createdAt ? 1 : -1;
  }
  return first.id < second.id ? 1 : first.id > second.id ? -1 : 0;
}

/**
 * `file` is `readdir`'s name, never composed from `build.id`, which a planted
 * document controls (#312).
 */
interface HeldManifest {
  file: string;
  manifest: Manifest;
}

interface StoreReading {
  held: readonly HeldManifest[];
  unreadable: readonly { file: string; error: unknown }[];
}

// `O_NOFOLLOW`: a planted link would put another file's bytes into a parse
// error a log quotes (#387). `?? 0` for Windows, which lacks the constant.
const STORE_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * Skips what it cannot open rather than throwing: one stale document after a
 * `MANIFEST_VERSION` bump must not fail every later build.
 */
async function readStore(root: string): Promise<StoreReading> {
  const held: HeldManifest[] = [];
  const unreadable: { file: string; error: unknown }[] = [];
  for (const name of await retainedFiles(root)) {
    const file = join(storeDir(root), name);
    try {
      const text = await readFile(file, {
        encoding: "utf8",
        flag: STORE_OPEN_FLAGS,
      });
      held.push({ file, manifest: readManifest(text, file) });
    } catch (error) {
      unreadable.push({ file, error });
    }
  }
  return { held: held.sort(newestFirst), unreadable };
}

export async function listRetainedManifests(
  root: string,
): Promise<readonly Manifest[]> {
  return (await readStore(root)).held.map(({ manifest }) => manifest);
}

function unreadableWarning(
  unreadable: readonly { file: string; error: unknown }[],
): string | undefined {
  if (unreadable.length === 0) return undefined;
  const subject =
    unreadable.length === 1
      ? "1 retained manifest could not be read and has been pruned"
      : `${String(unreadable.length)} retained manifests could not be read and have been pruned`;
  const lines = unreadable
    .map(({ error }) => `  ${printable(describeError(error))}`)
    .join("\n");
  return `Retention store: ${subject} — a build reads the store to record its own parent and to prune by the site's keep count, and a document this pagedeck cannot read answers neither; ignore this once after a pagedeck upgrade, or pin one pagedeck version across CI and local if it returns on every build:\n${lines}`;
}

const MISFILED_FIX = {
  one: `rename the file to the name its own build id spells, or delete it — and if that id cannot itself be a file name, ${ID_FIX}, and file the document under that`,
  many: `rename each file to the name its own build id spells, or delete it — and for any id that cannot itself be a file name, ${ID_FIX}, and file the document under that`,
};

function misfiledWarning(
  kept: readonly HeldManifest[],
  pruned: readonly HeldManifest[],
): string | undefined {
  const isMisfiled = ({ file, manifest }: HeldManifest): boolean =>
    basename(file) !== fileNameOf(manifest.build.id);
  const misfiled = [
    ...kept.filter(isMisfiled).map((one) => ({ ...one, gone: false })),
    ...pruned.filter(isMisfiled).map((one) => ({ ...one, gone: true })),
  ];
  if (misfiled.length === 0) return undefined;
  const [subject, fix] =
    misfiled.length === 1
      ? [
          "1 retained manifest is filed under a name that is not its build id",
          MISFILED_FIX.one,
        ]
      : [
          `${String(misfiled.length)} retained manifests are filed under names that are not their build ids`,
          MISFILED_FIX.many,
        ];
  const lines = misfiled
    .map(
      ({ file, manifest, gone }) =>
        `  ${quoteIdentifier(file)} — the build id is ${quoteIdentifier(manifest.build.id)}, and the file ${gone ? "has been pruned by this build" : "is still in the store"}`,
    )
    .join("\n");
  return `Retention store: ${subject} — pagedeck build writes each document to "<build id>.json" and reads it back by that id, so a document filed elsewhere is unreachable by rollback and was written by hand; ${fix}:\n${lines}`;
}

export async function retainManifest(
  root: string,
  manifest: Manifest,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<string | undefined> {
  assertUsableId(manifest.build.id);
  await mkdir(storeDir(root), { recursive: true });
  await writeFile(fileOf(root, manifest.build.id), manifestJson(manifest));

  const { held, unreadable } = await readStore(root);
  const pruned = held.slice(policy.keep);
  for (const { file } of pruned) await unlink(file);
  for (const { file } of unreadable) await unlink(file);
  const sections = [
    misfiledWarning(held.slice(0, policy.keep), pruned),
    unreadableWarning(unreadable),
  ].filter((section): section is string => section !== undefined);
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function missingFix(files: readonly string[]): string {
  if (files.length === 0) {
    return "the store holds no retained build, so run pagedeck build to fill it";
  }
  const ids = files
    .map((name) => quoteIdentifier(name.slice(0, -".json".length)))
    .join(", ");
  return `the retained builds are ${ids}, so roll back to one of those, or raise build.retention.keep before the build you want is pruned`;
}

/**
 * Listed, not "anything but `ENOENT`": an unlisted errno stays at exit 1, where
 * a retry may still fix it (#387).
 */
const UNREADABLE_DOCUMENT_CODES = new Set([
  "ELOOP",
  "EMLINK",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

export async function readRetainedManifest(
  root: string,
  id: string,
): Promise<Manifest> {
  assertUsableId(id);
  const file = fileOf(root, id);
  let text: string;
  try {
    text = await readFile(file, { encoding: "utf8", flag: STORE_OPEN_FLAGS });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== undefined && UNREADABLE_DOCUMENT_CODES.has(code)) {
      // Not `missingFix`: its listing comes off `readdir` and would name this
      // file.
      throw new ConfigError(
        `Retained manifest ${quoteIdentifier(id)}: nothing opened at ${quoteIdentifier(file)} — the open ends there on a link, on a directory, on a mode that forbids the read, or on a name the file system will not take, and the store opens every document read-only and never through a symlink, so a link is refused rather than followed; put a document this pagedeck can open at that path, or roll back to a build id the store already holds`,
        { cause },
      );
    }
    if (code !== "ENOENT") throw cause;
    throw new ConfigError(
      `Retained manifest ${quoteIdentifier(id)}: is not in the store at "${storeDir(root)}" — ${missingFix(await retainedFiles(root))}`,
      { cause },
    );
  }
  return readManifest(text, file);
}
