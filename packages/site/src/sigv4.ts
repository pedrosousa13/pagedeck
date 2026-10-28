import { createHash, createHmac } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";
export const SERVICE = "s3";

export const sha256hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();

export function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service = SERVICE,
): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

// RFC 3986: `encodeURIComponent` leaves `!'()*` alone, and SigV4 does not.
function encode(value: string, keepSlash = false): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? "/" : "%2F");
}

export function objectPath(bucket: string, key: string): string {
  return `/${bucket}/${encode(key, true)}`;
}

export function canonicalHeaders(
  host: string,
  headers: Readonly<Record<string, string>> = {},
): { canonical: string; signed: string } {
  const entries = [...Object.entries(headers), ["host", host] as const]
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/ +/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

function canonicalQuery(pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

// Canonical request, string to sign, and its HMAC under the scope's signing key.
function signature(options: {
  method: string;
  path: string;
  query: string;
  headers: { canonical: string; signed: string };
  payloadHash: string;
  amzDate: string;
  dateStamp: string;
  region: string;
  service: string;
  secretKey: string;
}): { scope: string; signature: string } {
  const scope = `${options.dateStamp}/${options.region}/${options.service}/aws4_request`;
  const canonicalRequest = [
    options.method,
    options.path,
    options.query,
    options.headers.canonical,
    options.headers.signed,
    options.payloadHash,
  ].join("\n");
  const stringToSign = [ALGORITHM, options.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = signingKey(options.secretKey, options.dateStamp, options.region, options.service);
  return { scope, signature: createHmac("sha256", key).update(stringToSign).digest("hex") };
}

export interface S3Access {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

export function presignPath(
  options: S3Access & {
    region: string;
    path: string;
    method: string;
    expires: number;
    now?: Date;
    headers?: Readonly<Record<string, string>>;
  },
): string {
  const { host, protocol } = new URL(options.endpoint);
  const headers = canonicalHeaders(host, options.headers);
  const { amzDate, dateStamp } = stamps(options.now ?? new Date());
  const scope = `${dateStamp}/${options.region}/${SERVICE}/aws4_request`;
  const query = canonicalQuery([
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${options.accessKey}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(options.expires)],
    ["X-Amz-SignedHeaders", headers.signed],
  ]);
  const signed = signature({
    method: options.method,
    path: options.path,
    query,
    headers,
    payloadHash: "UNSIGNED-PAYLOAD",
    amzDate,
    dateStamp,
    region: options.region,
    service: SERVICE,
    secretKey: options.secretKey,
  });
  return `${protocol}//${host}${options.path}?${query}&X-Amz-Signature=${signed.signature}`;
}

/** The headers that sign a request in its `Authorization` header, with each header given. */
export function signHeaders(options: {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  body: string;
  now?: Date;
  headers?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const { host, pathname, searchParams } = new URL(options.url);
  const { amzDate, dateStamp } = stamps(options.now ?? new Date());
  const sent: Record<string, string> = {
    ...options.headers,
    "x-amz-date": amzDate,
    ...(options.sessionToken === undefined ? {} : { "x-amz-security-token": options.sessionToken }),
  };
  const headers = canonicalHeaders(host, sent);
  const { scope, signature: signed } = signature({
    method: options.method,
    path: pathname,
    query: canonicalQuery([...searchParams]),
    headers,
    payloadHash: sha256hex(options.body),
    amzDate,
    dateStamp,
    region: options.region,
    service: options.service,
    secretKey: options.secretKey,
  });
  return {
    ...sent,
    authorization: `${ALGORITHM} Credential=${options.accessKey}/${scope}, SignedHeaders=${headers.signed}, Signature=${signed}`,
  };
}
