import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { S3Origin } from "./s3-origin.test-support.js";
import { putHeaders, readRequests } from "./presign.js";
import type { PutRequest } from "./presign.js";
import { presign } from "./sigv4.test-support.js";

export const DEPLOY_BIN = join(import.meta.dirname, "..", "dist", "deploy.bin.js");

export interface CliRun {
  argv: readonly string[];
  code: number;
  stdout: string;
  stderr: string;
}

export interface SignedDeploy {
  // The last dry run; `dries` holds every one, in order.
  dry: CliRun;
  dries: CliRun[];
  apply?: CliRun;
  // The PUT keys the dry run asked to have signed, in the order the apply sends them.
  puts: string[];
  // The DELETE keys the last dry run asked to have signed.
  deletes: string[];
}

export interface SigningOptions {
  origin: S3Origin;
  bucket: string;
  // Where the URL and request files are written, and the CLI's working directory.
  dir: string;
  // Signs the PUTs with another secret, for a run the origin refuses.
  putSecret?: string;
}

const objectKey = (key: string): string => key.replace(/^\//, "");

// A PUT given as a request is signed for its type and MD5, as `presign.bin.js` signs it.
export function signUrls(
  options: SigningOptions,
  name: string,
  keys: { get?: readonly string[]; put?: readonly (string | PutRequest)[]; delete?: readonly string[] },
): string {
  const sign = (method: string, key: string, secretKey: string, headers?: Record<string, string>): string =>
    presign({ ...options.origin, secretKey, bucket: options.bucket, key: objectKey(key), method, ...(headers === undefined ? {} : { headers }) });
  const document = {
    get: Object.fromEntries((keys.get ?? []).map((key) => [key, sign("GET", key, options.origin.secretKey)])),
    put: Object.fromEntries(
      (keys.put ?? []).map((put) =>
        typeof put === "string"
          ? [put, sign("PUT", put, options.putSecret ?? options.origin.secretKey)]
          : [put.key, sign("PUT", put.key, options.putSecret ?? options.origin.secretKey, putHeaders(put))],
      ),
    ),
    delete: Object.fromEntries(
      (keys.delete ?? []).map((key) => [key, sign("DELETE", key, options.putSecret ?? options.origin.secretKey)]),
    ),
  };
  const file = join(options.dir, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

export async function runDeployCli(
  options: Pick<SigningOptions, "origin" | "dir">,
  argv: readonly string[],
  urls: string,
): Promise<CliRun> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [DEPLOY_BIN, ...argv],
      {
        cwd: options.dir,
        env: { ...process.env, PAGEDECK_DEPLOY_URLS: urls, NODE_EXTRA_CA_CERTS: options.origin.caFile },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ argv, code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
}

// A prune signs one more round: its first dry run learns from the history index which
// documents to read, and only the second can plan the DELETEs (#659).
export async function signedDeploy(
  options: SigningOptions,
  argv: readonly string[],
  reads: readonly string[],
  dryRuns = 1,
): Promise<SignedDeploy> {
  const requests = join(options.dir, "requests.json");
  let signed = signUrls(options, "reads.json", { get: reads });
  const dries: CliRun[] = [];
  let puts: string[] = [];
  let deletes: string[] = [];
  for (let pass = 0; pass < dryRuns; pass += 1) {
    const dry = await runDeployCli(options, [...argv, "--requests", requests], signed);
    dries.push(dry);
    if (dry.code !== 0) return { dry, dries, puts: [], deletes: [] };
    const asked = readRequests(readFileSync(requests, "utf8"), requests);
    puts = asked.put.map((put) => put.key);
    deletes = [...asked.delete];
    signed = signUrls(options, "signed.json", { get: asked.get, put: asked.put, delete: deletes });
  }
  const apply = await runDeployCli(options, [...argv, "--apply"], signed);
  return { dry: dries.at(-1) as CliRun, dries, apply, puts, deletes };
}

// What must never reach an argv or an output stream: the credential, and any part
// of a signed URL's query string.
export function credentialLeaks(origin: S3Origin, runs: readonly (CliRun | undefined)[]): string[] {
  const secrets = [
    ["the access key", origin.accessKey],
    ["the secret key", origin.secretKey],
    ["a signed query", "X-Amz-"],
    ["a signature", "Signature="],
  ] as const;
  const leaks: string[] = [];
  for (const run of runs) {
    if (run === undefined) continue;
    for (const [where, text] of [
      ["argv", run.argv.join(" ")],
      ["stdout", run.stdout],
      ["stderr", run.stderr],
    ] as const) {
      for (const [name, secret] of secrets) if (text.includes(secret)) leaks.push(`${where} holds ${name}`);
    }
  }
  return leaks;
}
