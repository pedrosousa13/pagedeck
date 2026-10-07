// Signed over `host` alone, so a URL can be signed before the request's headers are known.
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
  },
): string {
  const { host, protocol } = new URL(options.endpoint);
  const { amzDate, dateStamp } = stamps(options.now ?? new Date());
  const scope = `${dateStamp}/${options.region}/${SERVICE}/aws4_request`;
  const canonicalQuery = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${options.accessKey}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(options.expires)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([k, v]) => [encode(k as string), encode(v as string)])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1))
    .map(([k, v]) => `${k as string}=${v as string}`)
    .join("&");
  const canonicalRequest = [
    options.method,
    options.path,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(options.secretKey, dateStamp, options.region))
    .update(stringToSign)
    .digest("hex");
  return `${protocol}//${host}${options.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
