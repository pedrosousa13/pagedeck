import { readFile } from "node:fs/promises";
import {
  ConfigError,
  deployKeyFault,
  fileKey,
  localAddressKind,
  quoteIdentifier,
  readManifest,
  redactTarget,
} from "@pagedeck/core";
import { isReservedDeployKey } from "@pagedeck/core/routing";
import type { Manifest } from "@pagedeck/core";
import type { DeployPlan } from "./deploy.js";
import type { UnreadableDeployInstant } from "./deploy-run.js";
import {
  applyPlan,
  deployInstantKey,
  HISTORY_INDEX_KEY,
  HISTORY_INDEX_MAX_BYTES,
  HISTORY_INDEX_TOO_LARGE,
  historyIndexFault,
  MANIFEST_KEY,
  presignedTarget,
  readDeployInstant,
  readHistoryIndex,
  requestFailed,
  retainedKey,
} from "./deploy-target.js";
import type { DeployTarget } from "./deploy-target.js";
import type { ObjectMetadata } from "./deploy-metadata.js";

export const DEPLOY_URLS_VARIABLE = "PAGEDECK_DEPLOY_URLS";

const SHAPE = '{"get": {key: URL}, "put": {key: URL}, "delete": {key: URL}}';

const METHODS = ["get", "put", "delete"] as const;
type Method = (typeof METHODS)[number];

export interface DeployUrls {
  get: ReadonlyMap<string, string>;
  put: ReadonlyMap<string, string>;
  delete: ReadonlyMap<string, string>;
}

const RESERVED_FIX = `sign no DELETE for ${quoteIdentifier("/manifest.json")} or under ${quoteIdentifier("/.pagedeck/")}`;

// Faults name the method and the key and never quote a URL: a presigned URL carries
// its credential in its query string. A key or field is the file's own text, and a
// map written backwards puts a URL there, so each is quoted through `redactTarget`.
const quoteKey = (key: string): string => quoteIdentifier(redactTarget(key));

function urlFault(method: Method, key: string, value: unknown): { fault: string } | { base: string } {
  const where = `${method} ${quoteKey(key)}`;
  const keyFault = deployKeyFault(key);
  if (keyFault !== undefined) return { fault: `${where}: is not a deploy key — ${keyFault}` };
  if (method === "delete" && isReservedDeployKey(key)) {
    return { fault: `${where}: is a key the deploy writes for itself, and a prune never deletes one — ${RESERVED_FIX}` };
  }
  if (typeof value !== "string") return { fault: `${where}: is not a string — write the URL as a string` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { fault: `${where}: is not a URL — write an absolute https: URL` };
  }
  if (url.protocol !== "https:") {
    return {
      fault: `${where}: is a ${url.protocol} URL — presign it over https, because a presigned URL carries its credential and a deploy sends bytes only over https`,
    };
  }
  // `fetch` refuses such a URL with a message that quotes it whole.
  if (url.username !== "" || url.password !== "") {
    return {
      fault: `${where}: carries a user name or password before its host — presign it without one; a presigned URL carries its credential in the signature`,
    };
  }
  const kind = localAddressKind(url.hostname);
  if (kind !== undefined) {
    return { fault: `${where}: names a ${kind} host — point it at the origin, not at this runner` };
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  if (!path.endsWith(key)) {
    return {
      fault: `${where}: its path does not end in ${quoteKey(key)}, so a ${method.toUpperCase()} through it would write another key — sign each URL for the key it is listed under`,
    };
  }
  return { base: `${url.host}${path.slice(0, -key.length)}` };
}

export async function readDeployUrls(file: string): Promise<DeployUrls> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new ConfigError(
      `Deploy URLs ${quoteIdentifier(file)}: could not be opened (${(cause as NodeJS.ErrnoException).code ?? "no error code"}) — point ${DEPLOY_URLS_VARIABLE} at the file the signing step wrote`,
      { cause },
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ConfigError(
      `Deploy URLs ${quoteIdentifier(file)}: is not valid JSON — write it as ${SHAPE}; the parser's own message is not printed, because it quotes the file and the file holds credentials`,
    );
  }

  const faults: string[] = [];
  const urls = {
    get: new Map<string, string>(),
    put: new Map<string, string>(),
    delete: new Map<string, string>(),
  };
  const based: { method: Method; key: string; base: string }[] = [];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(document)) {
    faults.push(`(document): is not an object — write it as ${SHAPE}`);
  } else {
    for (const field of Object.keys(document)) {
      if (!METHODS.some((method) => method === field)) {
        faults.push(
          `${quoteKey(field)}: is not a field this deploy reads — the fields are "get", "put" and "delete"`,
        );
      }
    }
    for (const method of METHODS) {
      const entries = document[method];
      if (entries === undefined) continue;
      if (!isObject(entries)) {
        faults.push(`"${method}": is not an object of key to URL — write it as {key: URL}`);
        continue;
      }
      for (const [key, value] of Object.entries(entries)) {
        const checked = urlFault(method, key, value);
        if ("fault" in checked) {
          faults.push(checked.fault);
          continue;
        }
        urls[method].set(key, value as string);
        based.push({ method, key, base: checked.base });
      }
    }
  }
  // One origin per document: a URL signed for `/en/index.html` also ends in
  // `/index.html`, and only the path before the key tells the two apart.
  const counts = new Map<string, number>();
  for (const one of based) counts.set(one.base, (counts.get(one.base) ?? 0) + 1);
  let origin: string | undefined;
  for (const [base, count] of counts) {
    if (origin === undefined || count > (counts.get(origin) ?? 0)) origin = base;
  }
  for (const one of based.filter((entry) => entry.base !== origin)) {
    faults.push(
      `${one.method} ${quoteKey(one.key)}: names a different host, or a different path before the key, than the other URLs do, so it could write another key — sign every URL for one origin`,
    );
  }
  if (faults.length > 0) {
    throw new ConfigError(
      [
        `Deploy URLs ${quoteIdentifier(file)}: ${String(faults.length)} ${faults.length === 1 ? "entry" : "entries"} cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
        ...faults.map((fault) => `  ${fault}`),
      ].join("\n"),
    );
  }
  return urls;
}

function unsignedRead(key: string): ConfigError {
  return new ConfigError(
    `Deploy read of ${quoteIdentifier(key)}: ${DEPLOY_URLS_VARIABLE} holds no GET URL for this key, which the run reads before it plans — sign a GET for it; a dry run with --requests lists every key to sign`,
  );
}

// Stops pulling once past `limit.bytes`, so a host cannot make the run hold an unbounded body.
async function cappedText(response: Response, limit: { bytes: number; refuse: () => Error }): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit.bytes) {
      await reader.cancel();
      throw limit.refuse();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// `undefined` for a 404 only: any other answer is a failure, never an absent object.
export async function originRead(
  urls: DeployUrls,
  key: string,
  limit?: { bytes: number; refuse: () => Error },
): Promise<string | undefined> {
  const url = urls.get.get(key);
  if (url === undefined) throw unsignedRead(key);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", redirect: "manual" });
  } catch (cause) {
    throw requestFailed(`Deploy read of ${quoteIdentifier(key)}`, url, cause);
  }
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Deploy read of ${quoteIdentifier(key)}: the host answered ${String(response.status)} to GET — re-presign the URL, and check that the credential it was signed with may read this key. The URL is not printed: it carries the credential in its query string.`,
    );
  }
  return limit === undefined ? await response.text() : await cappedText(response, limit);
}

export async function readSignedIndex(urls: DeployUrls): Promise<readonly string[] | undefined> {
  const text = await originRead(urls, HISTORY_INDEX_KEY, {
    bytes: HISTORY_INDEX_MAX_BYTES,
    refuse: () => historyIndexFault(HISTORY_INDEX_TOO_LARGE),
  });
  return text === undefined ? undefined : readHistoryIndex(text);
}

export interface SignedHistory {
  // Every key of the history the prune reads, for the requests a dry run writes.
  reads: readonly string[];
  retention?: {
    published: readonly Manifest[];
    deployedAt: ReadonlyMap<string, Date>;
    unreadableDeployInstants: readonly UnreadableDeployInstant[];
  };
  // Set when there is no retention: why the prune deletes nothing, as a clause.
  withheld?: string;
}

const NO_INDEX = `the origin holds no history index at ${quoteIdentifier(HISTORY_INDEX_KEY)}, so this run cannot know which builds the origin served, and does not guess them — apply once with this pagedeck, which writes the index, and prune on a run after that; a file that only builds deployed before then named is never found, so delete it by hand if its bytes matter`;

export async function readSignedHistory(
  urls: DeployUrls,
  index: readonly string[] | undefined,
  options: { listUnsigned: boolean },
): Promise<SignedHistory> {
  if (index === undefined) return { reads: [], withheld: NO_INDEX };
  const reads = index.flatMap((id) => [retainedKey(id), deployInstantKey(id)]);
  const unsigned = reads.filter((key) => !urls.get.has(key));
  const [first] = unsigned;
  if (first !== undefined) {
    if (!options.listUnsigned) throw unsignedRead(first);
    return {
      reads,
      withheld: `the prune reads ${String(unsigned.length)} ${unsigned.length === 1 ? "key" : "keys"} of the origin's deploy history that ${DEPLOY_URLS_VARIABLE} holds no GET URL for, so this dry run plans no DELETE — sign the requests it wrote, and run the dry run again with the signed file to list the DELETEs`,
    };
  }
  const published: Manifest[] = [];
  const deployedAt = new Map<string, Date>();
  const unreadable: UnreadableDeployInstant[] = [];
  for (const id of index) {
    const key = retainedKey(id);
    const text = await originRead(urls, key);
    if (text === undefined) continue;
    try {
      published.push(readManifest(text, `origin:${key}`));
    } catch {
      continue;
    }
    const instantKey = deployInstantKey(id);
    const instantText = await originRead(urls, instantKey);
    if (instantText === undefined) continue;
    const instant = readDeployInstant(instantText);
    if (instant === undefined) {
      unreadable.push({ key: instantKey, reason: "it holds no ISO-8601 instant" });
    } else {
      deployedAt.set(id, instant);
    }
  }
  return { reads, retention: { published, deployedAt, unreadableDeployInstants: unreadable } };
}

export interface PlannedPut {
  key: string;
  metadata: ObjectMetadata;
}

// The apply itself against a target that records, so the list cannot drift from it.
export async function plannedPuts(plan: DeployPlan, source: string): Promise<PlannedPut[]> {
  const puts: PlannedPut[] = [];
  await applyPlan(plan, {
    source,
    target: {
      name: "planned puts",
      async put(key, _body, metadata) {
        puts.push({ key, metadata });
      },
      async delete() {
        throw new Error("Deploy: an apply deletes nothing");
      },
    },
  });
  return puts;
}

export function unsignedPuts(urls: DeployUrls, puts: readonly PlannedPut[]): ConfigError | undefined {
  const missing = puts.map((one) => one.key).filter((key) => !urls.put.has(key));
  if (missing.length === 0) return undefined;
  return new ConfigError(
    [
      `Deploy: ${DEPLOY_URLS_VARIABLE} holds no PUT URL for ${String(missing.length)} ${missing.length === 1 ? "key" : "keys"} this apply writes, so nothing was sent — re-run the dry run with --requests, sign every key it lists, and apply with the file that signing writes:`,
      ...missing.map((key) => `  ${quoteIdentifier(key)}`),
    ].join("\n"),
  );
}

// Refused at any run, dry or applying: no signer should be asked for these.
export function reservedDeletes(
  deletes: readonly string[],
  history: readonly Manifest[],
): ConfigError | undefined {
  const reserved = deletes.filter((key) => isReservedDeployKey(key));
  if (reserved.length === 0) return undefined;
  const namedBy = (key: string): string => {
    const holders = history
      .filter((one) => one.files.some((file) => fileKey(file.domain, file.path) === key))
      .map((one) => quoteIdentifier(retainedKey(one.build.id)));
    return holders.length === 0 ? quoteIdentifier(MANIFEST_KEY) : holders.join(", ");
  };
  return new ConfigError(
    [
      `Deploy: the prune would delete ${String(reserved.length)} ${reserved.length === 1 ? "key" : "keys"} the deploy writes for itself, so nothing was sent — no build emits such a key, so the document in the origin's deploy history that names it was not filed by an apply; replace that document with the manifest.json its build wrote, and the prune plans no DELETE for the key:`,
      ...reserved.map((key) => `  ${quoteIdentifier(key)}, named by ${namedBy(key)}`),
    ].join("\n"),
  );
}

export function unsignedDeletes(urls: DeployUrls, deletes: readonly string[]): ConfigError | undefined {
  const missing = deletes.filter((key) => !urls.delete.has(key));
  if (missing.length === 0) return undefined;
  return new ConfigError(
    [
      `Deploy: ${DEPLOY_URLS_VARIABLE} holds no DELETE URL for ${String(missing.length)} ${missing.length === 1 ? "key" : "keys"} this prune deletes, so nothing was sent — re-run the dry run with --prune and --requests, sign every key it lists, and apply with the file that signing writes:`,
      ...missing.map((key) => `  ${quoteIdentifier(key)}`),
    ].join("\n"),
  );
}

export function requestsDocument(
  reads: readonly string[],
  puts: readonly PlannedPut[],
  deletes: readonly string[],
): string {
  const document = {
    get: Object.fromEntries(reads.map((key) => [key, {}])),
    put: Object.fromEntries(puts.map((one) => [one.key, one.metadata])),
    delete: Object.fromEntries(deletes.map((key) => [key, {}])),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function signedUrlTarget(urls: DeployUrls): DeployTarget {
  return presignedTarget({
    put: (key) => {
      const url = urls.put.get(key);
      if (url === undefined) {
        throw new ConfigError(
          `Deploy of ${quoteIdentifier(key)}: ${DEPLOY_URLS_VARIABLE} holds no PUT URL for this key`,
        );
      }
      return url;
    },
    delete: (key) => {
      const url = urls.delete.get(key);
      if (url === undefined) {
        throw new ConfigError(
          `Deploy of ${quoteIdentifier(key)}: ${DEPLOY_URLS_VARIABLE} holds no DELETE URL for this key — re-run the dry run with --prune and --requests, and sign every DELETE it lists`,
        );
      }
      return url;
    },
  });
}
