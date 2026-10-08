// This holds the credential: no message here quotes a URL or a variable's value.
import { ConfigError, deployKeyFault, quoteIdentifier } from "@pagedeck/core";
import { isReservedDeployKey } from "@pagedeck/core/routing";
import { isDeployInstantKey } from "./deploy-target.js";
import { objectPath, presignPath } from "./sigv4.js";

/**
 * Each signing pass feeds the one run after it, a dry run or the apply: long enough for
 * that run, short enough that a leaked URL is soon dead.
 */
export const PRESIGN_EXPIRES_SECONDS = 900;

export const SIGNING_VARIABLES = {
  endpoint: "PAGEDECK_S3_ENDPOINT",
  region: "PAGEDECK_S3_REGION",
  bucket: "PAGEDECK_S3_BUCKET",
  accessKey: "PAGEDECK_S3_ACCESS_KEY_ID",
  secretKey: "PAGEDECK_S3_SECRET_ACCESS_KEY",
} as const;

export type SigningAccess = Record<keyof typeof SIGNING_VARIABLES, string>;

export function signingAccess(env: NodeJS.ProcessEnv): SigningAccess {
  const entries = Object.entries(SIGNING_VARIABLES) as [keyof SigningAccess, string][];
  const missing = entries
    .filter(([, name]) => (env[name] ?? "").trim() === "")
    .map(([, name]) => name);
  if (missing.length > 0) {
    throw new ConfigError(
      `Signing: ${String(missing.length)} ${missing.length === 1 ? "variable is" : "variables are"} not set — set each from the repository's secrets, in the step that signs and in no other: ${missing.join(", ")}`,
    );
  }
  const access = Object.fromEntries(
    entries.map(([field, name]) => [field, (env[name] as string).trim()]),
  ) as SigningAccess;
  const endpoint = URL.parse(access.endpoint);
  if (
    endpoint === null ||
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== ""
  ) {
    throw new ConfigError(
      `Signing: ${SIGNING_VARIABLES.endpoint} is not an https: origin with no path, user or query — set it to the bucket host's S3 endpoint, such as https://<account id>.r2.cloudflarestorage.com; its value is not printed`,
    );
  }
  return { ...access, endpoint: endpoint.origin };
}

export interface PutRequest {
  key: string;
  contentType: string;
  cacheControl: string;
  contentMd5?: string;
}

export interface Requests {
  get: readonly string[];
  put: readonly PutRequest[];
  delete: readonly string[];
}

const METHODS = ["get", "put", "delete"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;

function putRequest(key: string, entry: unknown): PutRequest | string {
  if (!isObject(entry)) return "is not an object — write it as {contentType, cacheControl, contentMd5}";
  const { contentType, cacheControl, contentMd5 } = entry;
  if (typeof contentType !== "string") return 'has no "contentType" string — a PUT is signed for the type it sends';
  if (typeof cacheControl !== "string") return 'has no "cacheControl" string — a PUT is signed for the cache policy it sends';
  if (contentMd5 === undefined) {
    return isDeployInstantKey(key)
      ? { key, contentType, cacheControl }
      : 'has no "contentMd5" — a PUT is signed for the bytes it sends, and only the deploy instant has none; run the dry run again on the same build and sign the file it writes';
  }
  if (typeof contentMd5 !== "string" || !MD5_BASE64.test(contentMd5)) {
    return 'its "contentMd5" is not the base64 MD5 of a body — a PUT is signed for the bytes it sends';
  }
  return { key, contentType, cacheControl, contentMd5 };
}

export function readRequests(text: string, file: string): Requests {
  const fix = "pass the file deploy.bin.js --requests wrote";
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ConfigError(
      `Signing: ${quoteIdentifier(file)} is not valid JSON — ${fix}; the parser's own message is not printed, because it quotes the file`,
    );
  }
  if (!isObject(document)) {
    throw new ConfigError(`Signing: ${quoteIdentifier(file)} is not an object — ${fix}`);
  }
  const faults: string[] = [];
  for (const field of Object.keys(document)) {
    if (!METHODS.some((method) => method === field)) {
      faults.push(`${quoteIdentifier(field)}: is not a field the deploy reads — the fields are "get", "put" and "delete"`);
    }
  }
  const requests = { get: [] as string[], put: [] as PutRequest[], delete: [] as string[] };
  for (const method of METHODS) {
    const entries = document[method];
    if (entries === undefined) continue;
    if (!isObject(entries)) {
      faults.push(`"${method}": is not an object of key to request — write it as {key: {}}`);
      continue;
    }
    for (const key of Object.keys(entries)) {
      const keyFault = deployKeyFault(key);
      if (keyFault !== undefined) {
        faults.push(`${method} ${quoteIdentifier(key)}: is not a deploy key — ${keyFault}`);
        continue;
      }
      if (method === "delete" && isReservedDeployKey(key)) {
        faults.push(
          `delete ${quoteIdentifier(key)}: is a key the deploy writes for itself, and a prune never deletes one — sign no DELETE for "/manifest.json" or under "/.pagedeck/"`,
        );
        continue;
      }
      if (method === "put") {
        const put = putRequest(key, entries[key]);
        if (typeof put === "string") faults.push(`put ${quoteIdentifier(key)}: ${put}`);
        else requests.put.push(put);
        continue;
      }
      requests[method].push(key);
    }
  }
  if (faults.length > 0) {
    throw new ConfigError(
      [
        `Signing: ${quoteIdentifier(file)} has ${String(faults.length)} ${faults.length === 1 ? "entry" : "entries"} that cannot be signed, and nothing was signed — ${fix}:`,
        ...faults.map((fault) => `  ${fault}`),
      ].join("\n"),
    );
  }
  return requests;
}

export const putHeaders = (put: PutRequest): Record<string, string> => ({
  "content-type": put.contentType,
  "cache-control": put.cacheControl,
  ...(put.contentMd5 === undefined ? {} : { "content-md5": put.contentMd5 }),
});

// Every header a PUT sends is signed, so a leaked URL writes only those bytes with that
// type and cache policy (#60). Content-MD5 because R2 documents no x-amz-checksum-* header.
export function presignRequests(requests: Requests, access: SigningAccess, now = new Date()): string {
  const sign = (
    method: "GET" | "PUT" | "DELETE",
    key: string,
    headers?: Readonly<Record<string, string>>,
  ): [string, string] => [
    key,
    presignPath({
      ...access,
      path: objectPath(access.bucket, key.slice(1)),
      method,
      expires: PRESIGN_EXPIRES_SECONDS,
      now,
      ...(headers === undefined ? {} : { headers }),
    }),
  ];
  return `${JSON.stringify({
    get: Object.fromEntries(requests.get.map((key) => sign("GET", key))),
    put: Object.fromEntries(requests.put.map((put) => sign("PUT", put.key, putHeaders(put)))),
    delete: Object.fromEntries(requests.delete.map((key) => sign("DELETE", key))),
  })}\n`;
}
