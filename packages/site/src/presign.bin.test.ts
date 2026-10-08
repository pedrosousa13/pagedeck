import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EXIT_CODES } from "@pagedeck/core";

const BIN = join(import.meta.dirname, "..", "dist", "presign.bin.js");

const ENDPOINT_HOST = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";
const CREDENTIAL = {
  PAGEDECK_S3_ENDPOINT: `https://${ENDPOINT_HOST}`,
  PAGEDECK_S3_REGION: "auto",
  PAGEDECK_S3_BUCKET: "landing",
  PAGEDECK_S3_ACCESS_KEY_ID: "AKIDEXAMPLEACCESSKEY",
  PAGEDECK_S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYsecretkey",
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pagedeck-presign-bin-"));
  writeFileSync(
    join(dir, "requests.json"),
    JSON.stringify({
      get: { "/manifest.json": {} },
      put: { "/index.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" } },
      delete: { "/old.html": {} },
    }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  argv: readonly string[];
  code: number;
  stdout: string;
  stderr: string;
}

async function presign(argv: readonly string[], env: Record<string, string>): Promise<Run> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...argv],
      { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env } },
      (error, stdout, stderr) => {
        resolve({ argv, code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
}

// The credential's parts, the endpoint's account-bearing host, and any part of a signed URL.
function leaks(run: Run): string[] {
  const secrets = [
    ["the access key", CREDENTIAL.PAGEDECK_S3_ACCESS_KEY_ID],
    ["the secret key", CREDENTIAL.PAGEDECK_S3_SECRET_ACCESS_KEY],
    ["the endpoint", ENDPOINT_HOST],
    ["a signed query", "X-Amz-"],
  ] as const;
  const found: string[] = [];
  for (const [where, text] of [
    ["argv", run.argv.join(" ")],
    ["stdout", run.stdout],
    ["stderr", run.stderr],
  ] as const) {
    for (const [name, secret] of secrets) if (text.includes(secret)) found.push(`${where} holds ${name}`);
  }
  return found;
}

test("signs the requests into a file only its owner can read, and prints no credential or URL", async () => {
  const run = await presign(["requests.json", "signed.json"], CREDENTIAL);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(EXIT_CODES.success);
  expect(run.stdout).toBe(
    'Signed 3 requests (1 GET, 1 PUT, 1 DELETE) into "signed.json", each valid for 900 seconds. The URLs are not printed: each carries the credential in its query string.\n',
  );
  expect(leaks(run)).toEqual([]);
  const file = join(dir, "signed.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const signed = JSON.parse(readFileSync(file, "utf8")) as Record<"get" | "put" | "delete", Record<string, string>>;
  expect(new URL(signed.get["/manifest.json"] as string).pathname).toBe("/landing/manifest.json");
  expect(new URL(signed.put["/index.html"] as string).pathname).toBe("/landing/index.html");
  expect(new URL(signed.delete["/old.html"] as string).pathname).toBe("/landing/old.html");
}, 60_000);

test("without the credential it names what is missing, writes nothing and exits 2", async () => {
  const run = await presign(["requests.json", "unsigned.json"], {
    PAGEDECK_S3_SECRET_ACCESS_KEY: CREDENTIAL.PAGEDECK_S3_SECRET_ACCESS_KEY,
  });
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(
    "PAGEDECK_S3_ENDPOINT, PAGEDECK_S3_REGION, PAGEDECK_S3_BUCKET, PAGEDECK_S3_ACCESS_KEY_ID",
  );
  expect(leaks(run)).toEqual([]);
  expect(() => statSync(join(dir, "unsigned.json"))).toThrow();
}, 60_000);

test("refuses to write the URLs over the requests", async () => {
  const run = await presign(["requests.json", "./requests.json"], CREDENTIAL);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain('"requests.json" is both the requests and the file to write');
  expect(leaks(run)).toEqual([]);
}, 60_000);

test("names the two files it takes in the sentence that refuses one", async () => {
  const run = await presign(["requests.json"], CREDENTIAL);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toMatch(
    /^Signing takes two files — pass the requests file deploy\.bin\.js --requests wrote, then the file to write the URLs to\.\n\nUsage: /,
  );
}, 60_000);
