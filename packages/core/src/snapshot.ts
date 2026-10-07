import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ConfigError, printable } from "./exit.js";

/**
 * No `http:`: a snapshot is the site's whole content, and a rewritable channel
 * would let anyone on the path choose what the site publishes.
 */
const SUPPORTED_SCHEMES = ["file:", "https:"];

const IPV4_LITERAL = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

const IPV4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

const SQLITE_HEADER = "SQLite format 3\0";

const TARGET_DELIMITER = /[?#]/;

/**
 * Unbounded and greedy, `[\s\S]` for a target holding a newline: the value
 * failed to parse, so nothing in it says where a credential ends (#320).
 */
const TARGET_USERINFO = /^[\s\S]*@/;

export function redactTarget(url: string): string {
  let redacted: string;
  try {
    const parsed = new URL(url);
    redacted =
      parsed.host === "" && parsed.protocol !== "file:"
        ? parsed.protocol
        : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Userinfo before the query: a `?` in a password must not end the quote
    // inside the credential.
    const stripped = url.replace(TARGET_USERINFO, "…@");
    const delimiter = stripped.search(TARGET_DELIMITER);
    redacted =
      delimiter === -1 ? stripped : `${stripped.slice(0, delimiter + 1)}…`;
  }
  // Over both branches, although a parse already strips control characters.
  return printable(redacted);
}

function ipv4Octets(host: string): number[] | undefined {
  const literal = IPV4_LITERAL.exec(host);
  if (literal) return literal.slice(1).map(Number);
  const mapped = IPV4_MAPPED.exec(host);
  if (!mapped) return undefined;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/**
 * Private ranges pass on purpose: an internal artifact store over `10.x` is a
 * snapshot host somebody meant.
 */
export function localAddressKind(hostname: string): string | undefined {
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const octets = ipv4Octets(host);
  if (octets) {
    if (octets.every((octet) => octet === 0)) return "loopback";
    if (octets[0] === 127) return "loopback";
    if (octets[0] === 169 && octets[1] === 254) return "link-local";
    return undefined;
  }
  if (!host.startsWith("[")) return undefined;
  if (host === "[::1]" || host === "[::]") return "loopback";
  // `fe80::/10` is a leading group of fe80 to febf, never the one elided.
  const leading = Number.parseInt(host.slice(1).split(":")[0], 16);
  return leading >= 0xfe80 && leading <= 0xfebf ? "link-local" : undefined;
}

function parseTarget(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(
      `Snapshot target "${redactTarget(url)}" is not a URL — give an absolute file: or https: URL`,
    );
  }
  if (!SUPPORTED_SCHEMES.includes(parsed.protocol)) {
    throw new ConfigError(
      `Snapshot target "${redactTarget(url)}": scheme "${parsed.protocol}" is not supported — use ${SUPPORTED_SCHEMES.join(" or ")} (an S3-style target is an https: presigned URL)`,
    );
  }
  const kind = localAddressKind(parsed.hostname);
  if (kind !== undefined) {
    // Through `redactTarget`, although a hostname holds nothing to cut today.
    throw new ConfigError(
      `Snapshot target "${redactTarget(url)}": host "${redactTarget(parsed.hostname)}" is a ${kind} host — no snapshot is served from this runner or its link, and a push to one would PUT the site's whole content store to whatever the target names; point the target at the host the snapshot lives on`,
    );
  }
  return parsed;
}

function assertSqlite(prefix: Uint8Array, url: string): void {
  const header = Buffer.from(
    prefix.buffer,
    prefix.byteOffset,
    Math.min(prefix.byteLength, SQLITE_HEADER.length),
  ).toString("binary");
  if (header !== SQLITE_HEADER) {
    throw new Error(
      `Snapshot at "${redactTarget(url)}" is not a SQLite database — it starts with ${JSON.stringify(header.slice(0, 16))}`,
    );
  }
}

/** One `handle.write` may land fewer bytes than given: a full disk, say. */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
    );
    written += bytesWritten;
  }
}

/**
 * `expected` checks completeness, not size: a snapshot has no maximum (#76).
 */
async function replaceFile(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  url: string,
  expected?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.pagedeck-snapshot`);
  const handle = await open(temporary, "wx");
  try {
    let head = Buffer.alloc(0);
    let checked = false;
    let written = 0;
    try {
      for await (const chunk of chunks) {
        if (checked) {
          await writeAll(handle, chunk);
          written += chunk.byteLength;
          continue;
        }
        head = Buffer.concat([head, chunk]);
        if (head.byteLength < SQLITE_HEADER.length) continue;
        assertSqlite(head, url);
        checked = true;
        await writeAll(handle, head);
        written = head.byteLength;
      }
      if (!checked) assertSqlite(head, url);
    } finally {
      await handle.close();
    }
    if (expected !== undefined && written !== expected) {
      throw pullFailed(
        url,
        undefined,
        `the host declared ${expected} bytes and the body carried ${written} — the store at "${printable(path)}" is left as it was rather than replaced by a snapshot that is not the one the host described; re-run the pull`,
      );
    }
    await rename(temporary, path);
  } catch (error) {
    // A failed cleanup must not mask the error that says why the pull failed.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * `redirect: "manual"`: following one could move the transfer onto `http:`, or
 * on a push send the whole store wherever a 307 points.
 */
async function request(
  target: URL,
  url: string,
  what: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(target, { ...init, redirect: "manual" });
  } catch (error) {
    throw new Error(`Snapshot ${what} "${redactTarget(url)}" failed`, {
      cause: error,
    });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Snapshot ${what} "${redactTarget(url)}" failed: the host answered HTTP ${response.status}, a redirect — redirects are not followed, because they can move the transfer off https:. Point the target at the final location.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Snapshot ${what} "${redactTarget(url)}" failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

function pullFailed(url: string, cause: unknown, detail?: string): Error {
  const suffix = detail === undefined ? "" : `: ${detail}`;
  return new Error(`Snapshot pull from "${redactTarget(url)}" failed${suffix}`, {
    cause,
  });
}

async function* named(
  chunks: AsyncIterable<Uint8Array>,
  url: string,
): AsyncIterable<Uint8Array> {
  try {
    yield* chunks;
  } catch (error) {
    throw pullFailed(url, error);
  }
}

/**
 * Lazy: a source opened eagerly would leak its descriptor whenever
 * `replaceFile` fails before reading it.
 */
async function* readSnapshotFile(
  target: URL,
  url: string,
): AsyncIterable<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await open(fileURLToPath(target), "r");
  } catch (error) {
    throw pullFailed(url, error);
  }
  yield* named(handle.createReadStream(), url);
}

/**
 * Chunked must be the last coding: `transfer-encoding: identity` leaves the
 * body delimited by the connection close, so silently truncatable.
 */
function endsChunked(header: string | null): boolean {
  if (header === null) return false;
  const codings = header.split(",");
  return codings[codings.length - 1].trim().toLowerCase() === "chunked";
}

/**
 * A `content-encoding` is refused on the counted path: `fetch` decodes, so the
 * length counts encoded bytes and could never match (#313).
 */
function expectedLength(response: Response, url: string): number | undefined {
  // Before the length: chunked framing overrides a `content-length`.
  if (endsChunked(response.headers.get("transfer-encoding"))) return undefined;
  const declared = response.headers.get("content-length");
  if (declared === null) {
    throw pullFailed(
      url,
      undefined,
      `the host declared neither a content-length nor a chunked transfer-encoding, so the body ends wherever the connection does and a cut transfer ends it as quietly as a complete one — whatever arrived would be renamed over the store; serve the snapshot with a content-length (a presigned S3 GET does) or chunked`,
    );
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null) {
    throw pullFailed(
      url,
      undefined,
      `the host sent the body with content-encoding: ${printable(encoding)}, and fetch decodes it before it is written, so the declared length counts other bytes than the ones that would reach the store — serve the snapshot unencoded, or chunked, which needs no length`,
    );
  }
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw pullFailed(
      url,
      undefined,
      `the host declared a content-length of "${printable(declared)}", which is not a count of bytes, so there is nothing to check the snapshot against — serve the snapshot with a content-length that counts its bytes`,
    );
  }
  return length;
}

/**
 * The caller must have no store open on `storePath`: SQLite would go on serving
 * the replaced file from its page cache.
 */
export async function pullSnapshot(
  url: string,
  storePath: string,
): Promise<void> {
  const target = parseTarget(url);

  if (target.protocol === "file:") {
    await replaceFile(storePath, readSnapshotFile(target, url), url);
    return;
  }

  const response = await request(target, url, "pull from");
  if (response.body === null) {
    throw pullFailed(
      url,
      undefined,
      `the host answered HTTP ${response.status} with no body — point the target at a snapshot`,
    );
  }
  const expected = expectedLength(response, url);
  await replaceFile(storePath, named(response.body, url), url, expected);
}

export async function pushSnapshot(
  storePath: string,
  url: string,
): Promise<void> {
  const target = parseTarget(url);

  let size: number;
  try {
    size = (await stat(storePath)).size;
  } catch (error) {
    throw new Error(`No store to push at "${storePath}" — run pagedeck sync first`, {
      cause: error,
    });
  }

  if (target.protocol === "file:") {
    const destination = fileURLToPath(target);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(storePath, destination);
    } catch (error) {
      throw new Error(`Snapshot push to "${redactTarget(url)}" failed`, {
        cause: error,
      });
    }
    return;
  }

  await request(target, url, "push to", {
    method: "PUT",
    body: Readable.toWeb(createReadStream(storePath)),
    // Required of any streamed body: undici refuses one without it.
    duplex: "half",
    headers: {
      "content-type": "application/vnd.sqlite3",
      // S3's PUT refuses a chunked body, so a streamed one declares its length.
      "content-length": String(size),
    },
  });
}
