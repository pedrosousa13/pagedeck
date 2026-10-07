import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { openStore } from "@pagedeck/content";
import { ConfigError } from "./exit.js";
import { pullSnapshot, pushSnapshot } from "./snapshot.js";

// Replaces `open` only: a short write(2) is what a full disk looks like, and no
// portable call reproduces one.
let shortWrite: number | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const limit = shortWrite;
      if (limit === null) return handle;
      return {
        write: (bytes: Uint8Array, offset?: number, length?: number) =>
          handle.write(
            bytes,
            offset ?? 0,
            Math.min(length ?? bytes.byteLength, limit),
          ),
        close: () => handle.close(),
        createReadStream: () => handle.createReadStream(),
      };
    },
  };
});

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  shortWrite = null;
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// With a length: an unframed response is refused before a byte is written (#313).
function served(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  length: number,
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(length) },
  });
}

function writeStore(path: string, title: string): void {
  const store = openStore(path);
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "home",
    data: { title },
  });
  store.close();
}

test("push then pull round-trips a store file byte-identically", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  const remote = join(dir, "remote", "snapshot.db");
  const restored = join(dir, "restored.db");
  writeStore(source, "Home");

  await pushSnapshot(source, pathToFileURL(remote).href);
  await pullSnapshot(pathToFileURL(remote).href, restored);

  expect(sha256(restored)).toBe(sha256(source));
  expect(sha256(remote)).toBe(sha256(source));
});

test("pull replaces an existing store file and leaves no partial file behind", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  const target = join(dir, "target", "content.db");
  writeStore(source, "Fresh");
  mkdirSync(join(dir, "target"));
  writeStore(target, "Stale");

  await pullSnapshot(pathToFileURL(source).href, target);

  expect(sha256(target)).toBe(sha256(source));
  expect(readdirSync(join(dir, "target"))).toEqual(["content.db"]);
});

test("pull over https writes the bytes the response carries", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const body = new Uint8Array(
    Buffer.concat([
      Buffer.from("SQLite format 3\0", "binary"),
      Buffer.from([1, 2, 3, 4]),
    ]),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(served(body, body.byteLength))),
  );

  await pullSnapshot("https://snapshots.example/site.db", target);

  expect(new Uint8Array(readFileSync(target))).toEqual(body);
});

test("push over https PUTs the store bytes to the url", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);

  await pushSnapshot(source, "https://snapshots.example/site.db");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  // `vi.fn()` over a zero-argument stub types its calls as `[]`, so the
  // arguments the code really passed are an untyped boundary named here.
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    URL,
    RequestInit,
  ];
  expect(String(url)).toBe("https://snapshots.example/site.db");
  expect(init.method).toBe("PUT");
  expect(await drain(init.body as ReadableStream<Uint8Array>)).toEqual(
    readFileSync(source),
  );
});

test("an https push hands fetch a stream rather than the whole store", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);

  await pushSnapshot(source, "https://snapshots.example/site.db");

  const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(init.body).toBeInstanceOf(ReadableStream);
  // undici refuses a streamed body without it, and a stubbed fetch does not,
  // so the option is pinned here rather than discovered on a real host.
  expect(init.duplex).toBe("half");
  expect(await drain(init.body as ReadableStream<Uint8Array>)).toEqual(
    readFileSync(source),
  );
});

test("an https push declares the store's length beside the streamed body", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);

  await pushSnapshot(source, "https://snapshots.example/site.db");

  const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(new Headers(init.headers).get("content-length")).toBe(
    String(statSync(source).size),
  );
  expect(init.body).toBeInstanceOf(ReadableStream);
});

// Stubbed so a regression fails on the request instead of connecting to the hosts
// under test.
function unreachedFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("a loopback target is refused naming the host", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  const error = await pullSnapshot(
    "https://localhost/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('host "localhost"');
  expect((error as Error).message).toContain("loopback");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the refusal describes the pull the caller ran, not a push", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  const error = await pullSnapshot(
    "https://localhost/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect((error as Error).message).not.toMatch(/a push PUTs/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the unspecified addresses are refused as the loopback they reach", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  for (const [target, host] of [
    ["https://0.0.0.0/site.db", "0.0.0.0"],
    ["https://0/site.db", "0.0.0.0"],
    ["https://[::]/site.db", "[::]"],
  ]) {
    const error = await pullSnapshot(target, join(dir, "content.db")).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`host "${host}"`);
    expect((error as Error).message).toContain("loopback");
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a loopback address spelled another way is refused as the address it is", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  const error = await pullSnapshot(
    "https://127.1/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('host "127.0.0.1"');
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an ipv6 loopback target is refused naming the host", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  const error = await pullSnapshot(
    "https://[::1]/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('host "[::1]"');
  expect((error as Error).message).toContain("loopback");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an ipv6 link-local target is refused naming the host", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  const error = await pullSnapshot(
    "https://[fe80::1]/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('host "[fe80::1]"');
  expect((error as Error).message).toContain("link-local");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a link-local push is refused before the store leaves the runner", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);

  const error = await pushSnapshot(
    source,
    "https://169.254.169.254/site.db?X-Amz-Signature=deadbeefcafe",
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  // The whole sentence: `docs/error-messages.md` quotes it.
  expect((error as Error).message).toBe(
    'Snapshot target "https://169.254.169.254/site.db": host "169.254.169.254" is a link-local host — no snapshot is served from this runner or its link, and a push to one would PUT the site\'s whole content store to whatever the target names; point the target at the host the snapshot lives on',
  );
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an ipv4-mapped loopback address is refused however it was spelled", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
    const error = await pullSnapshot(
      `https://${host}/site.db`,
      join(dir, "content.db"),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('host "[::ffff:7f00:1]"');
    expect((error as Error).message).toContain("loopback");
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an ipv4-mapped link-local address is refused as link-local", async () => {
  const dir = tempDir();
  const fetchMock = unreachedFetch();

  const error = await pullSnapshot(
    "https://[::ffff:169.254.169.254]/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('host "[::ffff:a9fe:a9fe]"');
  expect((error as Error).message).toContain("link-local");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an ipv4-mapped address that is not local is left alone", async () => {
  const dir = tempDir();
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(8, 5)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(served(body, body.byteLength))),
  );

  await pullSnapshot(
    "https://[::ffff:93.184.216.34]/site.db",
    join(dir, "site.db"),
  );

  expect(readFileSync(join(dir, "site.db"))).toEqual(body);
});

test("a host that only begins like a refused address is left alone", async () => {
  const dir = tempDir();
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(8, 5)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(served(body, body.byteLength))),
  );

  await pullSnapshot("https://127.example.com/site.db", join(dir, "site.db"));

  expect(readFileSync(join(dir, "site.db"))).toEqual(body);
});

test("an https pull that is refused fails naming the url and the status", async () => {
  const dir = tempDir();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("nope", { status: 403 }))),
  );

  const error = await pullSnapshot(
    "https://snapshots.example/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ConfigError);
  expect((error as Error).message).toMatch(
    /https:\/\/snapshots\.example\/site\.db.*403/,
  );
});

test("an https push that is refused fails naming the url and the status", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
  );

  await expect(
    pushSnapshot(source, "https://snapshots.example/site.db"),
  ).rejects.toThrow(/500/);
});

test("an unsupported url scheme is a config error naming the scheme", async () => {
  const dir = tempDir();

  await expect(
    pullSnapshot("s3://bucket/site.db", join(dir, "content.db")),
  ).rejects.toThrow(ConfigError);
  await expect(
    pullSnapshot("s3://bucket/site.db", join(dir, "content.db")),
  ).rejects.toThrow(/scheme "s3:" is not supported/);
});

test("a target that is not a url at all is a config error", async () => {
  const dir = tempDir();

  await expect(
    pullSnapshot("./snapshot.db", join(dir, "content.db")),
  ).rejects.toThrow(ConfigError);
});

test("pushing a store that does not exist fails naming the missing file", async () => {
  const dir = tempDir();
  const missing = join(dir, "content.db");

  const error = await pushSnapshot(
    missing,
    pathToFileURL(join(dir, "out.db")).href,
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(missing);
});

test("a file pull of a snapshot that is not there fails naming the url", async () => {
  const dir = tempDir();
  const url = pathToFileURL(join(dir, "absent.db")).href;

  await expect(pullSnapshot(url, join(dir, "content.db"))).rejects.toThrow(url);
});

test("push writes into a remote directory that does not exist yet", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  const remote = join(dir, "deep", "nested", "snapshot.db");

  await pushSnapshot(source, pathToFileURL(remote).href);

  expect(sha256(remote)).toBe(sha256(source));
});

test("a snapshot round-trips bytes that are not valid text", async () => {
  const dir = tempDir();
  const source = join(dir, "bytes.db");
  // A SQLite header followed by bytes no UTF-8 decoder accepts, so a transport
  // that decoded to text anywhere would corrupt them rather than reorder them.
  writeFileSync(
    source,
    Buffer.concat([
      Buffer.from("SQLite format 3\0", "binary"),
      Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f]),
    ]),
  );

  const remote = pathToFileURL(join(dir, "remote.db")).href;
  await pushSnapshot(source, remote);
  await pullSnapshot(remote, join(dir, "back.db"));

  expect(readFileSync(join(dir, "back.db"))).toEqual(readFileSync(source));
});

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

const PRESIGNED =
  "https://bucket.example/site.db?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=900";

test("a failed pull names the target without its credential-bearing query", async () => {
  const dir = tempDir();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("nope", { status: 403 }))),
  );

  const error = await pullSnapshot(PRESIGNED, join(dir, "content.db")).catch(
    (e: unknown) => e,
  );

  expect((error as Error).message).toContain("https://bucket.example/site.db");
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).not.toContain("X-Amz-Signature");
});

test("a failed push names the target without its credential-bearing query", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
  );

  const error = await pushSnapshot(source, PRESIGNED).catch((e: unknown) => e);

  expect((error as Error).message).toContain("https://bucket.example/site.db");
  expect((error as Error).message).not.toContain("deadbeefcafe");
});

test("a rejected scheme is reported without the credentials in the url", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "s3://key:secret@bucket.example/site.db?token=deadbeefcafe",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).not.toContain("secret");
});

test("a rejected url with no host is reported as its scheme and nothing else", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "data:text/plain,deadbeefcafe",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).toContain("data:");
});

test("a target that is not a url is cut at a fragment as well as a query", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "bucket.example/site.db#sig=deadbeefcafe",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).toContain('"bucket.example/site.db#…"');
});

test("a target that is not a url is cut at a query, keeping the delimiter", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "bucket.example/site.db?sig=deadbeefcafe",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).toContain('"bucket.example/site.db?…"');
});

test("a scheme-less target has its userinfo replaced, not its host", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "//AKIAX:SECRET@bucket.s3.amazonaws.com/store.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("SECRET");
  expect((error as Error).message).not.toContain("AKIAX");
  expect((error as Error).message).toContain(
    '"…@bucket.s3.amazonaws.com/store.db"',
  );
});

test("a scheme-less target with userinfo and a query loses both", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "//AKIAX:SECRET@bucket.s3.amazonaws.com/store.db?X-Amz-Signature=deadbeefcafe",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("SECRET");
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).toContain(
    '"…@bucket.s3.amazonaws.com/store.db?…"',
  );
});

test.each([
  "https//AKIA:SECRET@bucket.example/store.db",
  "///AKIA:SECRET@host/db",
  " //AKIA:SECRET@host/db",
  "://AKIA:SECRET@host/db",
])("a stray slash does not save the credential in %j", async (target) => {
  const dir = tempDir();

  const error = await pullSnapshot(target, join(dir, "content.db")).catch(
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("SECRET");
  expect((error as Error).message).not.toContain("AKIA");
});

test("a dropped colon still leaves the host and path naming the target", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "https//AKIA:SECRET@bucket.example/store.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('"…@bucket.example/store.db"');
});

test("a raw ? inside a password does not end the quote inside the credential", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "//user:SECRET?x@host",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("SECRET");
  expect((error as Error).message).toContain('"…@host"');
});

test("a password holding a ? leaves the host and path intact", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "//user:pa?ss@host/store.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("pa?ss");
  expect((error as Error).message).toContain('"…@host/store.db"');
});

test("a scheme-less target loses its leading slashes with the userinfo", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "//user:secret@host/path",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("secret");
  expect((error as Error).message).toContain('"…@host/path"');
});

test("a scheme-less target with userinfo and a signature keeps only the host and path", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "//user:secret@host/path?sig=deadbeefcafe",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("secret");
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect((error as Error).message).toContain('"…@host/path?…"');
});

test("an @ on a later line is still caught", async () => {
  const dir = tempDir();

  const target = `store.db${String.fromCharCode(
    10,
  )}//AKIAX:SECRET@bucket.example/store.db`;

  const error = await pullSnapshot(target, join(dir, "content.db")).catch(
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain("SECRET");
  expect((error as Error).message).not.toContain("AKIAX");
  expect((error as Error).message).toContain('"…@bucket.example/store.db"');
});

test("an @ in a query is over-redacted on purpose", async () => {
  const dir = tempDir();

  const error = await pullSnapshot(
    "/reports?notify=someone@example.com",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain('"…@example.com"');
});

test("a target that is not a url cannot forge a line into the report", async () => {
  const dir = tempDir();

  const forged = `/tmp/site.db${String.fromCharCode(10)}pagedeck: everything is fine`;

  const error = await pullSnapshot(forged, join(dir, "content.db")).catch(
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).not.toContain(String.fromCharCode(10));
  expect((error as Error).message).toContain("/tmp/site.db");
});

test("a pull whose body is not a SQLite database is refused before it lands", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = sha256(target);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        served("<html>Sign in to the network</html>", 35),
      ),
    ),
  );

  const error = await pullSnapshot(PRESIGNED, target).catch((e: unknown) => e);

  expect((error as Error).message).toMatch(/not a SQLite database/);
  expect((error as Error).message).toContain("https://bucket.example/site.db");
  expect(sha256(target)).toBe(before);
});

test("a pull is not redirected off the scheme the allowlist checked", async () => {
  const dir = tempDir();
  const fetchMock = vi.fn(() =>
    Promise.resolve(redirect(302, "http://attacker.example/site.db")),
  );
  vi.stubGlobal("fetch", fetchMock);

  const error = await pullSnapshot(
    "https://bucket.example/site.db",
    join(dir, "content.db"),
  ).catch((e: unknown) => e);

  expect((error as Error).message).toMatch(/redirect/i);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(init.redirect).toBe("manual");
});

test("a push is not redirected, so the store never follows a 307 to another host", async () => {
  const dir = tempDir();
  const source = join(dir, "content.db");
  writeStore(source, "Home");
  const fetchMock = vi.fn(() =>
    Promise.resolve(redirect(307, "https://attacker.example/site.db")),
  );
  vi.stubGlobal("fetch", fetchMock);

  const error = await pushSnapshot(source, "https://bucket.example/site.db").catch(
    (e: unknown) => e,
  );

  expect((error as Error).message).toMatch(/redirect/i);
  const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(init.redirect).toBe("manual");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

// `highWaterMark: 0`: by default the stream refills as soon as a chunk is taken, so
// buffering and streaming would look the same.
function bodyOf(
  chunks: readonly (Uint8Array | (() => Promise<Uint8Array>))[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (next === chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[next++];
        controller.enqueue(typeof chunk === "function" ? await chunk() : chunk);
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
}

async function temporarySize(dir: string, atLeast: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const temporary = readdirSync(dir).find((name) =>
      name.endsWith(".pagedeck-snapshot"),
    );
    if (temporary) {
      const size = statSync(join(dir, temporary)).size;
      if (size >= atLeast) return size;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return -1;
}

test("an https pull puts each chunk on disk before it asks for the next", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const first = Buffer.concat([SQLITE_HEADER, Buffer.alloc(1024, 1)]);
  const second = Buffer.alloc(1024, 2);
  let onDiskBeforeSecondChunk = -1;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        served(
          bodyOf([
            first,
            async () => {
              onDiskBeforeSecondChunk = await temporarySize(
                dir,
                first.byteLength,
              );
              return second;
            },
          ]),
          first.byteLength + second.byteLength,
        ),
      ),
    ),
  );

  await pullSnapshot("https://snapshots.example/site.db", target);

  expect(onDiskBeforeSecondChunk).toBe(first.byteLength);
  expect(readFileSync(target)).toEqual(Buffer.concat([first, second]));
});

test("an https pull accepts a header the host split across two chunks", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const rest = Buffer.alloc(1024, 7);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        served(
          bodyOf([
            SQLITE_HEADER.subarray(0, 8),
            SQLITE_HEADER.subarray(8),
            rest,
          ]),
          SQLITE_HEADER.byteLength + rest.byteLength,
        ),
      ),
    ),
  );

  await pullSnapshot("https://snapshots.example/site.db", target);

  expect(readFileSync(target)).toEqual(Buffer.concat([SQLITE_HEADER, rest]));
});

test("an https pull of a body that ends before the header does is refused", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        served(bodyOf([SQLITE_HEADER.subarray(0, 6)]), 6),
      ),
    ),
  );

  await expect(
    pullSnapshot("https://snapshots.example/site.db", target),
  ).rejects.toThrow(/not a SQLite database/);
  expect(readdirSync(dir)).toEqual([]);
});

test("a pull whose writes land short still puts every byte in the store", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 3)]);
  shortWrite = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(served(bodyOf([body]), body.byteLength)),
    ),
  );

  await pullSnapshot("https://snapshots.example/site.db", target);

  expect(readFileSync(target)).toEqual(body);
});

test("an https pull of a success with no body at all is refused naming the url", async () => {
  const dir = tempDir();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );

  const error = await pullSnapshot(PRESIGNED, join(dir, "content.db")).catch(
    (e: unknown) => e,
  );

  expect((error as Error).message).toContain("https://bucket.example/site.db");
  expect((error as Error).message).toMatch(/no body/);
  expect((error as Error).message).not.toContain("deadbeefcafe");
});

test("an https pull that is not SQLite is refused without reading the rest", async () => {
  const dir = tempDir();
  let cancelled = false;
  let secondChunkRequested = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        served(
          bodyOf(
            [
              Buffer.from("<html>Sign in to the network</html>"),
              () => {
                secondChunkRequested = true;
                return Promise.resolve(Buffer.alloc(1024));
              },
            ],
            () => {
              cancelled = true;
            },
          ),
          1059,
        ),
      ),
    ),
  );

  const error = await pullSnapshot(PRESIGNED, join(dir, "content.db")).catch(
    (e: unknown) => e,
  );

  expect((error as Error).message).toMatch(/not a SQLite database/);
  expect(secondChunkRequested).toBe(false);
  expect(cancelled).toBe(true);
});

test("a pull that fails mid-transfer leaves no store and no temporary file", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = sha256(target);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        served(
          bodyOf([
            Buffer.concat([SQLITE_HEADER, Buffer.alloc(1024, 1)]),
            () => Promise.reject(new Error("connection reset by peer")),
          ]),
          SQLITE_HEADER.byteLength + 2048,
        ),
      ),
    ),
  );

  const error = await pullSnapshot(
    "https://snapshots.example/site.db",
    target,
  ).catch((e: unknown) => e);

  expect((error as Error).message).toContain("https://snapshots.example");
  expect((error as Error).cause).toBeInstanceOf(Error);
  expect(sha256(target)).toBe(before);
  expect(readdirSync(dir)).toEqual(["content.db"]);
});

test("concurrent pulls of the same store do not collide over one temp name", async () => {
  const dir = tempDir();
  const source = join(dir, "source.db");
  writeStore(source, "Home");
  const url = pathToFileURL(source).href;
  const target = join(dir, "content.db");

  await Promise.all([
    pullSnapshot(url, target),
    pullSnapshot(url, target),
    pullSnapshot(url, target),
  ]);

  expect(sha256(target)).toBe(sha256(source));
  expect([...readdirSync(dir)].sort()).toEqual(["content.db", "source.db"]);
});

// A raw socket: `node:http` frames and terminates every response it writes.
async function rawHost(
  respond: (socket: Socket) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      respond(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function closeDelimitedHost(
  payload: Buffer,
): ReturnType<typeof rawHost> {
  return rawHost((socket) => {
    socket.write(
      "HTTP/1.1 200 OK\r\ncontent-type: application/vnd.sqlite3\r\nconnection: close\r\n\r\n",
    );
    socket.write(payload);
    socket.end();
  });
}

function chunkedHost(
  payload: Buffer,
  sent = payload.byteLength,
  extra = "",
): ReturnType<typeof rawHost> {
  return rawHost((socket) => {
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-type: application/vnd.sqlite3\r\n${extra}transfer-encoding: chunked\r\n\r\n`,
    );
    socket.write(`${payload.byteLength.toString(16)}\r\n`);
    socket.write(payload.subarray(0, sent));
    if (sent === payload.byteLength) socket.write("\r\n0\r\n\r\n");
    socket.end();
  });
}

// The real `fetch` with only the destination swapped: `parseTarget` refuses a
// loopback HTTPS listener.
function fetchThrough(origin: string): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((target: URL, init: RequestInit) =>
      realFetch(`${origin}${new URL(target).pathname}`, init),
    ),
  );
}

test("a close-delimited body cut mid-transfer ends without an error", async () => {
  const host = await closeDelimitedHost(
    Buffer.concat([SQLITE_HEADER, Buffer.alloc(2048, 9)]),
  );
  try {
    const response = await fetch(`${host.origin}/site.db`);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();

    let read = 0;
    for await (const chunk of response.body as ReadableStream<Uint8Array>) {
      read += chunk.byteLength;
    }

    expect(read).toBe(SQLITE_HEADER.byteLength + 2048);
  } finally {
    await host.close();
  }
});

test("a pull of an unframed body is refused even when it is complete", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = sha256(target);
  const host = await closeDelimitedHost(
    Buffer.concat([SQLITE_HEADER, Buffer.alloc(2048, 9)]),
  );
  fetchThrough(host.origin);

  try {
    const error = await pullSnapshot(
      "https://snapshots.example/site.db",
      target,
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("https://snapshots.example");
    expect((error as Error).message).toMatch(
      /neither a content-length nor a chunked transfer-encoding/,
    );
    expect(sha256(target)).toBe(before);
    expect(readdirSync(dir)).toEqual(["content.db"]);
  } finally {
    await host.close();
  }
});

test("a pull whose body ends short of the declared length is refused naming both counts", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = sha256(target);
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(2048, 9)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(bodyOf([body]), {
          status: 200,
          headers: { "content-length": "9999" },
        }),
      ),
    ),
  );

  const error = await pullSnapshot(PRESIGNED, target).catch((e: unknown) => e);

  expect((error as Error).message).toContain("https://bucket.example/site.db");
  expect((error as Error).message).toContain("9999");
  expect((error as Error).message).toContain(String(body.byteLength));
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect(sha256(target)).toBe(before);
  expect(readdirSync(dir)).toEqual(["content.db"]);
});

test("a pull whose body is longer than the declared length is refused too", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(64, 9)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(bodyOf([body]), {
          status: 200,
          headers: { "content-length": "16" },
        }),
      ),
    ),
  );

  await expect(
    pullSnapshot("https://snapshots.example/site.db", target),
  ).rejects.toThrow(/declared 16 bytes/);
  expect(readdirSync(dir)).toEqual([]);
});

test("a content-encoded body is refused rather than measured against the wrong number", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(64, 9)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(bodyOf([body]), {
          status: 200,
          headers: {
            "content-length": String(body.byteLength),
            "content-encoding": "gzip",
          },
        }),
      ),
    ),
  );

  const error = await pullSnapshot(
    "https://snapshots.example/site.db",
    target,
  ).catch((e: unknown) => e);

  expect((error as Error).message).toContain("content-encoding");
  expect((error as Error).message).toContain("gzip");
  expect(readdirSync(dir)).toEqual([]);
});

test("a chunked pull is accepted, because its own framing ends the body", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const payload = Buffer.concat([SQLITE_HEADER, Buffer.alloc(2048, 9)]);
  const host = await chunkedHost(payload);
  fetchThrough(host.origin);

  try {
    await pullSnapshot("https://snapshots.example/site.db", target);

    expect(readFileSync(target)).toEqual(payload);
  } finally {
    await host.close();
  }
});

test("a truncated chunked pull is refused by the transport's own error", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = sha256(target);
  const payload = Buffer.concat([SQLITE_HEADER, Buffer.alloc(2048, 9)]);
  const host = await chunkedHost(payload, 1000);
  fetchThrough(host.origin);

  try {
    const error = await pullSnapshot(
      "https://snapshots.example/site.db",
      target,
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("https://snapshots.example");
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("terminated");
    expect(sha256(target)).toBe(before);
    expect(readdirSync(dir)).toEqual(["content.db"]);
  } finally {
    await host.close();
  }
});

test("the truncated unframed body #313 filed is refused, and the store keeps every byte", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = readFileSync(target);
  const payload = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 9)]);
  const host = await closeDelimitedHost(payload.subarray(0, 1000));
  fetchThrough(host.origin);

  try {
    const error = await pullSnapshot(
      "https://snapshots.example/site.db",
      target,
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("https://snapshots.example");
    expect((error as Error).message).toMatch(
      /neither a content-length nor a chunked transfer-encoding/,
    );
    expect(readFileSync(target)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["content.db"]);
  } finally {
    await host.close();
  }
});

test("a transfer-encoding that is not chunked does not buy a body out of the check", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  writeStore(target, "Precious");
  const before = readFileSync(target);
  const payload = Buffer.concat([SQLITE_HEADER, Buffer.alloc(4096, 9)]);
  const host = await rawHost((socket) => {
    socket.write(
      "HTTP/1.1 200 OK\r\ntransfer-encoding: identity\r\nconnection: close\r\n\r\n",
    );
    socket.write(payload.subarray(0, 1000));
    socket.end();
  });
  fetchThrough(host.origin);

  try {
    const error = await pullSnapshot(
      "https://snapshots.example/site.db",
      target,
    ).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(
      /neither a content-length nor a chunked transfer-encoding/,
    );
    expect(readFileSync(target)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["content.db"]);
  } finally {
    await host.close();
  }
});

test("a chunked body may be content-encoded, because nothing counts it", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const payload = Buffer.concat([SQLITE_HEADER, Buffer.alloc(2048, 9)]);
  const host = await chunkedHost(
    gzipSync(payload),
    undefined,
    "content-encoding: gzip\r\n",
  );
  fetchThrough(host.origin);

  try {
    await pullSnapshot("https://snapshots.example/site.db", target);

    expect(readFileSync(target)).toEqual(payload);
  } finally {
    await host.close();
  }
});

test("a content-length that is not a byte count is refused as unusable", async () => {
  const dir = tempDir();
  const target = join(dir, "content.db");
  const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(64, 9)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(bodyOf([body]), {
          status: 200,
          headers: { "content-length": "twenty" },
        }),
      ),
    ),
  );

  const error = await pullSnapshot(PRESIGNED, target).catch((e: unknown) => e);

  expect((error as Error).message).toContain("https://bucket.example/site.db");
  expect((error as Error).message).toContain('"twenty"');
  expect((error as Error).message).toMatch(/not a count of bytes/);
  expect((error as Error).message).not.toContain("deadbeefcafe");
  expect(readdirSync(dir)).toEqual([]);
});
