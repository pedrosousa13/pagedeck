import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, describeError, EXIT_CODES, quoteIdentifier } from "@pagedeck/core";
import {
  PRESIGN_EXPIRES_SECONDS,
  presignRequests,
  readRequests,
  SIGNING_VARIABLES,
  signingAccess,
} from "./presign.js";

const USAGE = [
  "Usage: node dist/presign.bin.js <requests.json> <signed.json>",
  "",
  `Signs every request deploy.bin.js --requests listed, with the credential in ${Object.values(SIGNING_VARIABLES).join(", ")},`,
  "and writes the URLs to <signed.json> for PAGEDECK_DEPLOY_URLS. Nothing else takes the credential.",
].join("\n");

function main(argv: readonly string[]): void {
  const [requests, output, ...rest] = argv;
  if (requests === undefined || output === undefined || rest.length > 0) {
    throw new ConfigError(
      [
        "Signing takes two files — pass the requests file deploy.bin.js --requests wrote, then the file to write the URLs to.",
        "",
        USAGE,
      ].join("\n"),
    );
  }
  if (resolve(requests) === resolve(output)) {
    throw new ConfigError(
      `Signing: ${quoteIdentifier(requests)} is both the requests and the file to write — write the URLs to another file.`,
    );
  }
  const access = signingAccess(process.env);
  let text: string;
  try {
    text = readFileSync(requests, "utf8");
  } catch (cause) {
    throw new ConfigError(
      `Signing: ${quoteIdentifier(requests)} could not be opened (${(cause as NodeJS.ErrnoException).code ?? "no error code"}) — pass the file deploy.bin.js --requests wrote`,
    );
  }
  const read = readRequests(text, requests);
  writeFileSync(output, presignRequests(read, access), { mode: 0o600 });
  const count = read.get.length + read.put.length + read.delete.length;
  process.stdout.write(
    `Signed ${String(count)} ${count === 1 ? "request" : "requests"} (${String(read.get.length)} GET, ${String(read.put.length)} PUT, ${String(read.delete.length)} DELETE) into ${quoteIdentifier(output)}, each valid for ${String(PRESIGN_EXPIRES_SECONDS)} seconds. The URLs are not printed: each carries the credential in its query string.\n`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // This executable's one stderr write, as in `deploy.bin.ts`.
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode =
    error instanceof ConfigError ? EXIT_CODES.configError : EXIT_CODES.syncFailed;
}
