import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ConfigError,
  deployKeyFault,
  fileKey,
  quoteIdentifier,
  redactTarget,
  RETENTION_DIR,
  unusableId,
} from "@pagedeck/core";
import type { DeployPlan, RetainedPrune } from "./deploy.js";
import { documentMetadata, fileMetadata, UNKNOWN_TYPE } from "./deploy-metadata.js";
import type { ObjectMetadata } from "./deploy-metadata.js";

// Core's `MANIFEST_FILE`, which is internal to `@pagedeck/core`.
const MANIFEST_FILE = "manifest.json";

export const MANIFEST_KEY = fileKey(undefined, `/${MANIFEST_FILE}`);

// Under `RETENTION_DIR`, so `listRetainedManifests(origin)` reads the origin's copy as a
// store. It drops no document: a dropped one would make the prune leak (#287).
export function retainedKey(id: string): string {
  return fileKey(undefined, `/${RETENTION_DIR}/${id}.json`);
}

// A file of its own, not a manifest field: the retained document stays the live
// manifest byte for byte. Not `.json`, so the store's reader never opens it (#403).
export function deployInstantKey(id: string): string {
  return fileKey(undefined, `/${RETENTION_DIR}/${id}.deployed-at`);
}

// Beside `RETENTION_DIR`, not in it: the store's reader would open a `.json` there as a
// manifest. One object, so a presigned origin, which cannot list, can find its history.
export const HISTORY_INDEX_KEY = fileKey(undefined, "/.pagedeck/deploy-history.json");

// The longest id whose `<id>.deployed-at` a 255-byte file name can hold, on either origin.
export const BUILD_ID_MAX_BYTES = 255 - ".deployed-at".length;

// Ten deploys a day for 27 years: a cap an origin reaches would stop every deploy to it.
export const HISTORY_INDEX_MAX_BUILDS = 100_000;

// The largest document the two caps above admit, so the body cap refuses nothing they do.
export const HISTORY_INDEX_MAX_BYTES =
  HISTORY_INDEX_MAX_BUILDS * (BUILD_ID_MAX_BYTES + 3) + '{"builds":[]}\n'.length;

function historyIndexDocument(ids: readonly string[]): string {
  return `${JSON.stringify({ builds: [...new Set(ids)].sort() })}\n`;
}

const INDEX_FIX = `rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/${RETENTION_DIR}/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named`;

export function historyIndexFault(reason: string): ConfigError {
  return new ConfigError(`Deploy history index ${quoteIdentifier(HISTORY_INDEX_KEY)}: ${reason} — ${INDEX_FIX}`);
}

export const HISTORY_INDEX_TOO_LARGE = `is larger than ${String(HISTORY_INDEX_MAX_BYTES)} bytes, the most an index of ${String(HISTORY_INDEX_MAX_BUILDS)} builds of ${String(BUILD_ID_MAX_BYTES)}-byte ids takes, so the rest was not read`;

// No message quotes the file: its bytes were written at the origin. Entries are named by
// position and size only.
export function readHistoryIndex(text: string): readonly string[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw historyIndexFault("is not valid JSON");
  }
  const builds =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)["builds"]
      : undefined;
  if (!Array.isArray(builds)) throw historyIndexFault('is not an object with a "builds" list');
  if (builds.length > HISTORY_INDEX_MAX_BUILDS) {
    throw historyIndexFault(
      `names ${String(builds.length)} builds, more than the ${String(HISTORY_INDEX_MAX_BUILDS)} an index holds`,
    );
  }
  for (const [index, id] of builds.entries()) {
    const entry = `entry ${String(index + 1)}`;
    if (typeof id !== "string" || unusableId(id) !== undefined) {
      throw historyIndexFault(`${entry} is not a build id a document can be filed under`);
    }
    const bytes = Buffer.byteLength(id);
    if (bytes > BUILD_ID_MAX_BYTES) {
      throw historyIndexFault(
        `${entry} is a build id of ${String(bytes)} bytes, longer than the ${String(BUILD_ID_MAX_BYTES)} a "<build id>.deployed-at" file name can hold`,
      );
    }
  }
  return builds as string[];
}

const UTC_INSTANT =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$/;

// Stricter than `Date.parse`, which reads a bare date or a local time as another
// instant; and `Date` rolls 30 February into March, so the parts are compared.
export function readDeployInstant(text: string): Date | undefined {
  const spelled = text.endsWith("\n") ? text.slice(0, -1) : text;
  const match = UTC_INSTANT.exec(spelled);
  if (match === null) return undefined;
  const instant = new Date(spelled);
  if (!Number.isFinite(instant.getTime())) return undefined;
  return instant.toISOString().slice(0, 19) === match[1] ? instant : undefined;
}

export interface DeployTarget {
  readonly name: string;
  put(key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void>;
  delete(key: string): Promise<void>;
}

export function filesystemTarget(root: string): DeployTarget {
  const fileOf = (key: string): string => {
    const fault = deployKeyFault(key);
    if (fault !== undefined) {
      throw new ConfigError(
        `Deploy of ${quoteIdentifier(key)}: is not a deploy key — ${fault}, so it could name a file outside the origin at ${quoteIdentifier(root)}`,
      );
    }
    return join(root, key.slice(1));
  };
  return {
    name: root,
    async put(key, body) {
      const file = fileOf(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    async delete(key) {
      await rm(fileOf(key), { force: true });
    },
  };
}

// A PUT is sent with exactly `Content-Type` and `Cache-Control` (#560); a signer that
// wants the host to enforce them signs both.
export interface PresignedUrls {
  put(key: string, metadata: ObjectMetadata): string | Promise<string>;
  delete(key: string): string | Promise<string>;
}

// The cause chain is copied with the URL cut wherever one of its messages repeats it:
// `describeError` prints every message in the chain.
function withoutUrl(cause: unknown, url: string): unknown {
  if (!(cause instanceof Error)) return cause;
  const search = URL.parse(url)?.search ?? "";
  const cut = (text: string): string => {
    const shorter = text.replaceAll(url, redactTarget(url));
    return search === "" ? shorter : shorter.replaceAll(search, "?…");
  };
  const inner = withoutUrl(cause.cause, url);
  const message = cut(cause.message);
  if (message === cause.message && inner === cause.cause) return cause;
  const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
  copy.name = cause.name;
  return copy;
}

export function requestFailed(subject: string, url: string, cause: unknown): Error {
  return new Error(
    `${subject}: the request failed — check that the origin is reachable from this runner. The URL is not printed: it carries the credential in its query string.`,
    { cause: withoutUrl(cause, url) },
  );
}

// No message prints the URL: a presigned URL carries its credential in the query
// string, and CI masking does not catch a URL CI composed.
export function presignedTarget(urls: PresignedUrls): DeployTarget {
  const send = async (
    key: string,
    url: string,
    method: "PUT" | "DELETE",
    upload?: { body: Uint8Array; metadata: ObjectMetadata },
  ): Promise<void> => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(
        `Deploy of "${key}": the presigned URL is a ${parsed.protocol} URL, and a deploy sends bytes only over https — presign it over https, the scheme pagedeck store push already requires`,
      );
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "manual",
        ...(upload === undefined
          ? {}
          : {
              body: upload.body,
              headers: {
                "content-type": upload.metadata.contentType,
                "cache-control": upload.metadata.cacheControl,
              },
            }),
      });
    } catch (cause) {
      throw requestFailed(`Deploy of ${quoteIdentifier(key)}`, url, cause);
    }
    if (!response.ok) {
      throw new Error(
        `Deploy of "${key}": the host answered ${String(response.status)} to ${method} — re-presign the URL, and check that the credential it was signed with may write this key. The URL is not printed: it carries the credential in its query string.`,
      );
    }
  };
  return {
    name: "presigned https target",
    async put(key, body, metadata) {
      await send(key, await urls.put(key, metadata), "PUT", { body, metadata });
    },
    async delete(key) {
      await send(key, await urls.delete(key), "DELETE");
    },
  };
}

export interface ApplyOptions {
  source: string;
  target: DeployTarget;
  staging?: string;
  now?: Date;
  history?: readonly string[];
}

export interface ApplyReport {
  uploaded: readonly string[];
  staged: readonly string[];
  retained: string;
  deployInstant: string;
  index: string;
  untyped: readonly string[];
}

async function bytesOf(
  source: string,
  domain: string | undefined,
  path: string,
): Promise<Uint8Array> {
  try {
    return await readFile(join(source, domain ?? "", path));
  } catch (cause) {
    throw new Error(
      domain === undefined
        ? `Deploy of "${path}": the source tree at ${quoteIdentifier(source)} does not hold this file, and every row of the plan is read from there — point the source at the tree the build being deployed wrote`
        : `Deploy of "${path}" in the ${quoteIdentifier(domain)} tree: ${quoteIdentifier(join(source, domain))} does not hold this file, and a domain tree's rows are read from its tree key's directory in the source tree at ${quoteIdentifier(source)} — point the source at the tree the build being deployed wrote`,
      { cause },
    );
  }
}

function escapedStagedPaths(staging: string, plan: DeployPlan): ConfigError | undefined {
  const escaped = (plan.edge?.outOfBand ?? [])
    .map((one) => one.staged)
    .filter((path) => {
      const inside = relative(resolve(staging), resolve(staging, path));
      return inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    });
  if (escaped.length === 0) return undefined;
  return new ConfigError(
    [
      `Deploy: ${String(escaped.length)} out-of-band edge ${escaped.length === 1 ? "artifact" : "artifacts"} would be staged outside the staging directory ${quoteIdentifier(staging)}, so nothing was uploaded or staged — each path comes from a routing tree's domain in the manifest, which pagedeck build never writes this way; build again and deploy the manifest that build writes:`,
      ...escaped.map((path) => `  ${quoteIdentifier(path)}`),
    ].join("\n"),
  );
}

// Tree files, edge tree files, the retained manifest, the deploy instant, the history
// index, and `manifest.json` last: nothing lands after the key naming the live build
// (#287, #403), and the index never names a build whose document is not up (#659).
export async function applyPlan(
  plan: DeployPlan,
  options: ApplyOptions,
): Promise<ApplyReport> {
  const staging = options.staging;
  if (staging !== undefined) {
    const escaped = escapedStagedPaths(staging, plan);
    if (escaped !== undefined) throw escaped;
  }
  const uploaded: string[] = [];
  const untyped: string[] = [];
  const put = async (key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void> => {
    await options.target.put(key, body, metadata);
    uploaded.push(key);
    if (metadata.contentType === UNKNOWN_TYPE) untyped.push(key);
  };
  for (const tree of plan.trees) {
    for (const file of tree.upload) {
      await put(file.key, await bytesOf(options.source, tree.domain, file.path), fileMetadata(file));
    }
    const edge = (plan.edge?.treeFiles ?? []).filter(
      (one) => one.domain === tree.domain,
    );
    for (const one of edge) {
      const key = fileKey(one.domain, one.path);
      await put(key, Buffer.from(one.contents), documentMetadata(key));
    }
  }

  const manifest = join(options.source, MANIFEST_FILE);
  let document: Uint8Array;
  try {
    document = await readFile(manifest);
  } catch (cause) {
    throw new Error(
      `Deploy: there is no manifest at ${quoteIdentifier(manifest)}, and a deploy publishes the build's own manifest.json so the next deploy can read which build is live — point the source at the tree pagedeck build wrote`,
      { cause },
    );
  }
  // The document being published and nothing else, so every history entry is a build
  // this origin served (#287).
  const retained = retainedKey(plan.to.id);
  await put(retained, document, documentMetadata(retained));

  const deployInstant = deployInstantKey(plan.to.id);
  const now = options.now ?? new Date();
  await put(
    deployInstant,
    Buffer.from(`${now.toISOString()}\n`),
    documentMetadata(deployInstant),
  );

  await put(
    HISTORY_INDEX_KEY,
    Buffer.from(historyIndexDocument([...(options.history ?? []), plan.to.id])),
    documentMetadata(HISTORY_INDEX_KEY),
  );

  await put(MANIFEST_KEY, document, documentMetadata(MANIFEST_KEY));

  const staged: string[] = [];
  if (staging !== undefined) {
    for (const one of plan.edge?.outOfBand ?? []) {
      const file = join(staging, one.staged);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, one.contents);
      staged.push(one.staged);
    }
  }
  return { uploaded, staged, retained, deployInstant, index: HISTORY_INDEX_KEY, untyped };
}

export interface PruneOptions {
  target: DeployTarget;
  now: Date;
}

// Before the deadline the rest stays, silently: a pipeline pruning on every deploy
// is right to find the window open.
export async function prunePlan(
  plan: DeployPlan,
  options: PruneOptions,
): Promise<readonly string[]> {
  const graceOver = options.now.getTime() >= Date.parse(plan.prune.notBefore);
  const deleted: string[] = [];
  for (const tree of plan.trees) {
    for (const file of tree.prune) {
      if (!graceOver && file.kind !== "html") continue;
      await options.target.delete(file.key);
      deleted.push(file.key);
    }
  }
  return deleted;
}

// A rollback keeps `prunePlan`: this assumes the newest history build is live,
// which a restore makes false.
export async function pruneSuperseded(
  prune: RetainedPrune,
  options: { target: DeployTarget },
): Promise<readonly string[]> {
  const deleted: string[] = [];
  for (const file of prune.due) {
    await options.target.delete(file.key);
    deleted.push(file.key);
  }
  return deleted;
}
