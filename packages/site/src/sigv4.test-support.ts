// `us-east-1`/`s3`: the smallest dialect an S3 implementation answers. The R2 signing step
// signs with `presignPath` too, in its own region (`presign.ts`).
import { createHmac } from "node:crypto";
import {
  ALGORITHM,
  objectPath,
  presignPath,
  sha256hex,
  signingKey,
  stamps,
  SERVICE,
} from "./sigv4.js";
import type { S3Access } from "./sigv4.js";

export { objectPath, signingKey } from "./sigv4.js";
export type { S3Access } from "./sigv4.js";

const REGION = "us-east-1";

export function presign(
  options: S3Access & {
    bucket: string;
    key: string;
    method: string;
    expires?: number;
    headers?: Readonly<Record<string, string>>;
  },
): string {
  return presignPath({
    ...options,
    region: REGION,
    path: objectPath(options.bucket, options.key),
    expires: options.expires ?? 900,
  });
}

export async function signedFetch(
  options: S3Access & { path: string; method?: string; body?: Uint8Array },
): Promise<Response> {
  const { host, protocol } = new URL(options.endpoint);
  const method = options.method ?? "GET";
  const { amzDate, dateStamp } = stamps(new Date());
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const payloadHash = sha256hex(options.body ?? "");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    options.path,
    "",
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(options.secretKey, dateStamp, REGION))
    .update(stringToSign)
    .digest("hex");
  return await fetch(`${protocol}//${host}${options.path}`, {
    method,
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `${ALGORITHM} Credential=${options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}
