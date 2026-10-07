import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  buildManifest,
  ConfigError,
  describeError,
  EXIT_CODES,
  planEntries,
  planRouting,
  planTiers,
} from "@pagedeck/core";
import type { EmittedFile, Manifest, Page } from "@pagedeck/core";
import { planDeploy } from "./deploy.js";
import {
  applyPlan,
  deployInstantKey,
  HISTORY_INDEX_KEY,
  HISTORY_INDEX_MAX_BYTES,
  MANIFEST_KEY,
  presignedTarget,
  retainedKey,
} from "./deploy-target.js";
import type { DeployTarget } from "./deploy-target.js";
import { documentMetadata } from "./deploy-metadata.js";
import type { ObjectMetadata } from "./deploy-metadata.js";
import { runDeploy } from "./deploy-run.js";
import {
  originRead,
  plannedPuts,
  readDeployUrls,
  readSignedHistory,
  readSignedIndex,
  signedUrlTarget,
} from "./deploy-urls.js";
import type { DeployUrls } from "./deploy-urls.js";

const SECRET = "X-Amz-Signature=deadbeefsecret";
const signed = (key: string): string => `https://origin.example/site${key}?${SECRET}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pagedeck-deploy-urls-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function urlsFile(document: unknown): string {
  const file = join(dir, "urls.json");
  writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
  return file;
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const caught: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

function stubFetch(answer: (url: string, init?: RequestInit) => Response): {
  calls: { url: string; method: string; redirect: string }[];
  restore: () => void;
} {
  const calls: { url: string; method: string; redirect: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", redirect: init?.redirect ?? "follow" });
    return answer(String(url), init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

test("a URL document reads into a GET, a PUT and a DELETE lookup by exact key", async () => {
  const urls = await readDeployUrls(
    urlsFile({
      get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) },
      put: { "/index.html": signed("/index.html") },
      delete: { "/old.html": signed("/old.html") },
    }),
  );
  expect(urls.get.get(MANIFEST_KEY)).toBe(signed(MANIFEST_KEY));
  expect(urls.put.get("/index.html")).toBe(signed("/index.html"));
  expect(urls.put.get("/index")).toBeUndefined();
  expect(urls.put.size).toBe(1);
  expect(urls.delete.get("/old.html")).toBe(signed("/old.html"));
  expect(urls.delete.size).toBe(1);
});

test("a URL document with no put reads as no PUT URLs, for the dry run that only reads", async () => {
  const urls = await readDeployUrls(urlsFile({ get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) } }));
  expect(urls.put.size).toBe(0);
  expect(urls.delete.size).toBe(0);
});

test("a DELETE URL is checked as a GET or PUT URL is, and one at a key the deploy writes for itself is refused (#659)", async () => {
  const file = urlsFile({
    get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) },
    delete: {
      "/old.html": signed("/old.html"),
      "/plain.html": `http://origin.example/site/plain.html?${SECRET}`,
      "/local.html": `https://127.0.0.1/site/local.html?${SECRET}`,
      "/app.js": signed("/other.js"),
      [MANIFEST_KEY]: signed(MANIFEST_KEY),
      "/.pagedeck/manifests/b1.json": signed("/.pagedeck/manifests/b1.json"),
      [HISTORY_INDEX_KEY]: signed(HISTORY_INDEX_KEY),
      "/.pagedeck": signed("/.pagedeck"),
    },
  });
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  const reserved = (key: string): string =>
    `  delete "${key}": is a key the deploy writes for itself, and a prune never deletes one — sign no DELETE for "/manifest.json" or under "/.pagedeck/"`;
  expect(error.message).toBe(
    [
      `Deploy URLs "${file}": 7 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
      `  delete "/plain.html": is a http: URL — presign it over https, because a presigned URL carries its credential and a deploy sends bytes only over https`,
      `  delete "/local.html": names a loopback host — point it at the origin, not at this runner`,
      `  delete "/app.js": its path does not end in "/app.js", so a DELETE through it would write another key — sign each URL for the key it is listed under`,
      reserved(MANIFEST_KEY),
      reserved("/.pagedeck/manifests/b1.json"),
      reserved(HISTORY_INDEX_KEY),
      reserved("/.pagedeck"),
    ].join("\n"),
  );
  expect(error.message).not.toContain("X-Amz");
  expect(error.message).not.toContain("origin.example");
});

test("a URL document refuses every unusable entry at once, and quotes keys but never a URL", async () => {
  const file = urlsFile({
    get: { [MANIFEST_KEY]: `http://origin.example/site/manifest.json?${SECRET}` },
    put: {
      "/index.html": `https://127.0.0.1:9000/site/index.html?${SECRET}`,
      "/about.html": `https://[fe80::1]/site/about.html?${SECRET}`,
      "/app.js": signed("/other.js"),
      "/style.css": `not a url ${SECRET}`,
      "/n.txt": 7,
      "relative.txt": signed("/relative.txt"),
    },
    post: {},
  });
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Deploy URLs "${file}": 8 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
      `  "post": is not a field this deploy reads — the fields are "get", "put" and "delete"`,
      `  get "/manifest.json": is a http: URL — presign it over https, because a presigned URL carries its credential and a deploy sends bytes only over https`,
      `  put "/index.html": names a loopback host — point it at the origin, not at this runner`,
      `  put "/about.html": names a link-local host — point it at the origin, not at this runner`,
      `  put "/app.js": its path does not end in "/app.js", so a PUT through it would write another key — sign each URL for the key it is listed under`,
      `  put "/style.css": is not a URL — write an absolute https: URL`,
      `  put "/n.txt": is not a string — write the URL as a string`,
      `  put "relative.txt": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character`,
    ].join("\n"),
  );
  expect(error.message).not.toContain("X-Amz");
  expect(error.message).not.toContain("origin.example");
  expect(error.cause).toBeUndefined();
});

test("a URL signed for a deeper key that ends in the same path is refused, because every URL shares one origin", async () => {
  const file = urlsFile({
    get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) },
    put: {
      "/app.js": signed("/app.js"),
      "/index.html": signed("/en/index.html"),
      "/about.html": `https://elsewhere.example/site/about.html?${SECRET}`,
    },
  });
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Deploy URLs "${file}": 2 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
      `  put "/index.html": names a different host, or a different path before the key, than the other URLs do, so it could write another key — sign every URL for one origin`,
      `  put "/about.html": names a different host, or a different path before the key, than the other URLs do, so it could write another key — sign every URL for one origin`,
    ].join("\n"),
  );
  expect(error.message).not.toContain("elsewhere.example");
});

test("a URL carrying a user name or password is refused by key, and neither part is printed", async () => {
  const file = urlsFile({
    get: { [MANIFEST_KEY]: `https://AKIAUSER:hunter2pass@origin.example/site/manifest.json?${SECRET}` },
    put: { "/index.html": `https://:hunter2pass@origin.example/site/index.html?${SECRET}` },
  });
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Deploy URLs "${file}": 2 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
      `  get "/manifest.json": carries a user name or password before its host — presign it without one; a presigned URL carries its credential in the signature`,
      `  put "/index.html": carries a user name or password before its host — presign it without one; a presigned URL carries its credential in the signature`,
    ].join("\n"),
  );
  for (const secret of ["AKIAUSER", "hunter2pass", "X-Amz"]) expect(error.message).not.toContain(secret);
});

test("a map written backwards, URL as key, is refused with the URL's query string cut", async () => {
  const backwards = signed("/index.html");
  const file = urlsFile({ [backwards]: "/manifest.json", put: { [backwards]: "/index.html" } });
  const error = await refusal(readDeployUrls(file));
  expect(error.message).toBe(
    [
      `Deploy URLs "${file}": 2 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
      `  "https://origin.example/site/index.html": is not a field this deploy reads — the fields are "get", "put" and "delete"`,
      `  put "https://origin.example/site/index.html": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character`,
    ].join("\n"),
  );
  expect(error.message).not.toContain("X-Amz");
  expect(error.message).not.toContain("deadbeef");
});

test("a URL document that is not JSON is refused without the parser's text, which would quote a credential", async () => {
  const file = urlsFile(`{"put": {"/index.html": "${signed("/index.html")}"`);
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    `Deploy URLs "${file}": is not valid JSON — write it as {"get": {key: URL}, "put": {key: URL}, "delete": {key: URL}}; the parser's own message is not printed, because it quotes the file and the file holds credentials`,
  );
  expect(error.cause).toBeUndefined();
});

test("a URL document that is not an object of get and put is refused", async () => {
  const file = urlsFile(["https://origin.example/x"]);
  const error = await refusal(readDeployUrls(file));
  expect(error.message).toBe(
    `Deploy URLs "${file}": 1 entry cannot be used, and nothing was sent — fix each in the signing step that wrote the file:\n  (document): is not an object — write it as {"get": {key: URL}, "put": {key: URL}, "delete": {key: URL}}`,
  );
  const map = urlsFile({ put: ["https://origin.example/x"] });
  expect((await refusal(readDeployUrls(map))).message).toContain(
    `\n  "put": is not an object of key to URL — write it as {key: URL}`,
  );
});

test("a URL document that cannot be opened is refused, naming the variable", async () => {
  const file = join(dir, "missing.json");
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    `Deploy URLs "${file}": could not be opened (ENOENT) — point PAGEDECK_DEPLOY_URLS at the file the signing step wrote`,
  );
});

test("a signed GET reads the object, a 404 reads as absent, and a failure names the key but not the URL", async () => {
  const urls = await readDeployUrls(
    urlsFile({ get: { [MANIFEST_KEY]: signed(MANIFEST_KEY), "/gone.json": signed("/gone.json") } }),
  );
  const stub = stubFetch((url) =>
    url.includes("/gone.json") ? new Response("no", { status: 404 }) : new Response("{}", { status: 200 }),
  );
  try {
    expect(await originRead(urls, MANIFEST_KEY)).toBe("{}");
    expect(await originRead(urls, "/gone.json")).toBeUndefined();
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([
    { url: signed(MANIFEST_KEY), method: "GET", redirect: "manual" },
    { url: signed("/gone.json"), method: "GET", redirect: "manual" },
  ]);

  const denied = stubFetch(() => new Response("denied", { status: 403 }));
  let error: Error;
  try {
    error = await refusal(originRead(urls, MANIFEST_KEY));
  } finally {
    denied.restore();
  }
  expect(error).not.toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    'Deploy read of "/manifest.json": the host answered 403 to GET — re-presign the URL, and check that the credential it was signed with may read this key. The URL is not printed: it carries the credential in its query string.',
  );

  const missing = await refusal(originRead(urls, "/.pagedeck/manifests/b1.json"));
  expect(missing).toBeInstanceOf(ConfigError);
  expect(missing.message).toBe(
    'Deploy read of "/.pagedeck/manifests/b1.json": PAGEDECK_DEPLOY_URLS holds no GET URL for this key, which the run reads before it plans — sign a GET for it; a dry run with --requests lists every key to sign',
  );
});


test("a request that fails names the key, keeps its cause, and no message in the chain holds the query string", async () => {
  const urls = await readDeployUrls(
    urlsFile({ get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) }, put: { "/index.html": signed("/index.html") } }),
  );
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const quoted = String(url);
    throw new TypeError("fetch failed", {
      cause: new Error(`could not reach ${quoted}, query ${new URL(quoted).search}`),
    });
  }) as typeof fetch;
  let read: Error;
  let put: Error;
  try {
    read = await refusal(originRead(urls, MANIFEST_KEY));
    const target = presignedTarget({ put: (key) => signed(key), delete: (key) => signed(key) });
    put = await refusal(target.put("/index.html", new Uint8Array([1]), documentMetadata("/index.html")));
  } finally {
    globalThis.fetch = real;
  }
  expect(read.message).toBe(
    'Deploy read of "/manifest.json": the request failed — check that the origin is reachable from this runner. The URL is not printed: it carries the credential in its query string.',
  );
  expect(put.message).toBe(
    'Deploy of "/index.html": the request failed — check that the origin is reachable from this runner. The URL is not printed: it carries the credential in its query string.',
  );
  for (const error of [read, put]) {
    expect(error.cause).toBeInstanceOf(Error);
    const printed = describeError(error);
    expect(printed).toContain("fetch failed");
    expect(printed).not.toContain("X-Amz");
    expect(printed).not.toContain("deadbeef");
  }
  expect(describeError(put)).toContain("could not reach https://origin.example/site/index.html, query ?…");
});

const HOME: Page = { locale: "en", path: "/", output: "/", dependencies: [] };

function manifestOf(id: string, outputs: readonly EmittedFile[]): Manifest {
  const entries = planEntries([{ page: HOME, islands: [] }], { modules: {} });
  return buildManifest({
    build: { id, createdAt: "2026-10-02T10:00:00.000Z" },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [HOME], trailingSlash: "never" }),
    pages: [HOME],
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs,
  });
}

function siteTree(): { to: Manifest; source: string } {
  const outputs: EmittedFile[] = [
    { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: "<!doctype html><title>Home</title>" },
    { path: "/assets/app-a1b2c3.js", kind: "js", contents: "console.log(1);", hashed: true },
  ];
  const to = manifestOf("build-01", outputs);
  const source = join(dir, "site");
  for (const file of outputs) {
    const at = join(source, file.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.contents);
  }
  writeFileSync(join(source, "manifest.json"), JSON.stringify(to));
  return { to, source };
}

test("the planned PUTs are the keys and metadata an apply puts, in its order", async () => {
  const { to, source } = siteTree();
  const plan = planDeploy({ to });
  const puts: { key: string; metadata: ObjectMetadata }[] = [];
  const target: DeployTarget = {
    name: "recording",
    async put(key, _body, metadata) {
      puts.push({ key, metadata });
    },
    async delete() {
      throw new Error("an apply deletes nothing");
    },
  };
  await applyPlan(plan, { source, target });
  expect(await plannedPuts(plan, source)).toEqual(puts);
  expect(puts.map((one) => one.key)).toEqual([
    "/assets/app-a1b2c3.js",
    "/index.html",
    retainedKey("build-01"),
    deployInstantKey("build-01"),
    HISTORY_INDEX_KEY,
    MANIFEST_KEY,
  ]);
});

test("a dry run against a presigned origin writes the requests an apply sends, and sends nothing", async () => {
  const { to, source } = siteTree();
  const urls = await readDeployUrls(urlsFile({ get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) } }));
  const requests = join(dir, "requests.json");
  const lines: string[] = [];
  const stub = stubFetch(() => new Response(null, { status: 500 }));
  let code: number;
  try {
    code = await runDeploy(
      { to, source, origin: "(a presigned origin)", presigned: { urls, reads: [MANIFEST_KEY], requests } },
      (line) => lines.push(line),
    );
  } finally {
    stub.restore();
  }
  expect(code).toBe(EXIT_CODES.success);
  expect(stub.calls).toEqual([]);
  const document = JSON.parse(readFileSync(requests, "utf8")) as {
    get: Record<string, unknown>;
    put: Record<string, ObjectMetadata>;
    delete: Record<string, unknown>;
  };
  expect(document.get).toEqual({ [MANIFEST_KEY]: {} });
  expect(Object.keys(document.put)).toEqual([
    "/assets/app-a1b2c3.js",
    "/index.html",
    retainedKey("build-01"),
    deployInstantKey("build-01"),
    HISTORY_INDEX_KEY,
    MANIFEST_KEY,
  ]);
  expect(document.delete).toEqual({});
  expect(document.put["/assets/app-a1b2c3.js"]).toEqual({
    contentType: "text/javascript; charset=utf-8",
    cacheControl: "public, max-age=31536000, immutable",
  });
  expect(lines).toContain(
    `Wrote the 7 requests an apply sends to "${requests}": sign each one, and pass the signed file to the --apply run as PAGEDECK_DEPLOY_URLS.`,
  );
  expect(lines.at(-1)).toContain("DRY RUN");
});

test("an apply missing a PUT URL for any key it writes is refused before any request", async () => {
  const { to, source } = siteTree();
  const urls = await readDeployUrls(
    urlsFile({ put: { "/index.html": signed("/index.html"), [MANIFEST_KEY]: signed(MANIFEST_KEY) } }),
  );
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  let error: Error;
  try {
    error = await refusal(
      runDeploy(
        { to, source, origin: "(a presigned origin)", apply: true, presigned: { urls, reads: [] } },
        () => undefined,
      ),
    );
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([]);
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Deploy: PAGEDECK_DEPLOY_URLS holds no PUT URL for 4 keys this apply writes, so nothing was sent — re-run the dry run with --requests, sign every key it lists, and apply with the file that signing writes:`,
      `  "/assets/app-a1b2c3.js"`,
      `  "${retainedKey("build-01")}"`,
      `  "${deployInstantKey("build-01")}"`,
      `  "${HISTORY_INDEX_KEY}"`,
    ].join("\n"),
  );
});

test("an apply PUTs each key only to the URL listed for it, and prints no URL", async () => {
  const { to, source } = siteTree();
  const keys = ["/assets/app-a1b2c3.js", "/index.html", retainedKey("build-01"), deployInstantKey("build-01"), HISTORY_INDEX_KEY, MANIFEST_KEY];
  const urls = await readDeployUrls(
    urlsFile({ put: Object.fromEntries(keys.map((key) => [key, signed(key)])) }),
  );
  const lines: string[] = [];
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  let code: number;
  try {
    code = await runDeploy(
      { to, source, origin: "(a presigned origin)", apply: true, presigned: { urls, reads: [] } },
      (line) => lines.push(line),
    );
  } finally {
    stub.restore();
  }
  expect(code).toBe(EXIT_CODES.success);
  expect(stub.calls).toEqual(keys.map((key) => ({ url: signed(key), method: "PUT", redirect: "manual" })));
  expect(lines).toContain("Uploaded 3 files to presigned https target.");
  expect(lines.join("\n")).not.toMatch(/X-Amz|origin\.example|\?/);
});

// Stamped with `build-01`, which sorts after it, so the walk blames its drops on
// `build-01` and times them from that build's stamp.
const OLD = manifestOf("build-00", [
  { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: "<!doctype html><title>Old</title>" },
  { path: "/assets/app-000000.js", kind: "js", contents: "console.log(0);", hashed: true },
  { path: "/old.txt", kind: "asset", contents: "old" },
]);
const PAST_GRACE = new Date("2026-11-01T00:00:00.000Z");
const DUE = ["/assets/app-000000.js", "/old.txt"];

function allPuts(): Record<string, string> {
  const keys = ["/assets/app-a1b2c3.js", "/index.html", retainedKey("build-01"), deployInstantKey("build-01"), HISTORY_INDEX_KEY, MANIFEST_KEY];
  return Object.fromEntries(keys.map((key) => [key, signed(key)]));
}

test("a dry run with --prune against a presigned origin lists each DELETE the prune sends, and sends nothing (#659)", async () => {
  const { to, source } = siteTree();
  const urls = await readDeployUrls(urlsFile({ get: { [MANIFEST_KEY]: signed(MANIFEST_KEY) } }));
  const requests = join(dir, "requests.json");
  const lines: string[] = [];
  const stub = stubFetch(() => new Response(null, { status: 500 }));
  try {
    await runDeploy(
      {
        to,
        source,
        origin: "(a presigned origin)",
        pruneAfterUpload: true,
        now: PAST_GRACE,
        retention: { live: to, published: [OLD] },
        presigned: { urls, reads: [MANIFEST_KEY], requests },
      },
      (line) => lines.push(line),
    );
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([]);
  const document = JSON.parse(readFileSync(requests, "utf8")) as { delete: Record<string, unknown> };
  expect(document.delete).toEqual({ "/assets/app-000000.js": {}, "/old.txt": {} });
  expect(lines).toContain(
    `Wrote the 9 requests an apply sends to "${requests}": sign each one, and pass the signed file to the --apply run as PAGEDECK_DEPLOY_URLS.`,
  );
  expect(lines.at(-1)).toContain("DRY RUN");
});

test("an apply with --prune DELETEs each key only to the URL signed for it, after every PUT, and prints no URL (#659)", async () => {
  const { to, source } = siteTree();
  const urls = await readDeployUrls(
    urlsFile({
      put: allPuts(),
      delete: { ...Object.fromEntries(DUE.map((key) => [key, signed(key)])), "/unplanned.txt": signed("/unplanned.txt") },
    }),
  );
  const lines: string[] = [];
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  try {
    await runDeploy(
      {
        to,
        source,
        origin: "(a presigned origin)",
        apply: true,
        pruneAfterUpload: true,
        now: PAST_GRACE,
        retention: { live: to, published: [OLD] },
        presigned: { urls, reads: [] },
      },
      (line) => lines.push(line),
    );
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([
    ...Object.keys(allPuts()).map((key) => ({ url: signed(key), method: "PUT", redirect: "manual" })),
    ...DUE.map((key) => ({ url: signed(key), method: "DELETE", redirect: "manual" })),
  ]);
  expect(lines).toContain("Pruned 2 files from presigned https target.");
  expect(lines.join("\n")).not.toMatch(/X-Amz|origin\.example|\?/);
});

test("an apply with --prune missing a DELETE URL for any key the prune deletes is refused before any request (#659)", async () => {
  const { to, source } = siteTree();
  const urls = await readDeployUrls(urlsFile({ put: allPuts(), delete: { "/old.txt": signed("/old.txt") } }));
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  let error: Error;
  try {
    error = await refusal(
      runDeploy(
        {
          to,
          source,
          origin: "(a presigned origin)",
          apply: true,
          pruneAfterUpload: true,
          now: PAST_GRACE,
          retention: { live: to, published: [OLD] },
          presigned: { urls, reads: [] },
        },
        () => undefined,
      ),
    );
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([]);
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      "Deploy: PAGEDECK_DEPLOY_URLS holds no DELETE URL for 1 key this prune deletes, so nothing was sent — re-run the dry run with --prune and --requests, sign every key it lists, and apply with the file that signing writes:",
      '  "/assets/app-000000.js"',
    ].join("\n"),
  );
});

test("a prune that would delete a key the deploy writes for itself is refused before any request, whatever URLs it holds (#659)", async () => {
  const { to, source } = siteTree();
  const planted: Manifest = {
    ...OLD,
    files: [
      ...OLD.files,
      { path: "/.pagedeck/manifests/build-x.json", kind: "asset", hash: "0", size: 1 },
      { path: "/manifest.json", kind: "asset", hash: "0", size: 1 },
    ],
  };
  const reserved = ["/.pagedeck/manifests/build-x.json", MANIFEST_KEY];
  // Built by hand: `readDeployUrls` refuses these DELETE URLs, and this pins the
  // refusal behind it.
  const urls: DeployUrls = {
    get: new Map(),
    put: new Map(Object.entries(allPuts())),
    delete: new Map([...DUE, ...reserved].map((key) => [key, signed(key)])),
  };
  const expected = [
    "Deploy: the prune would delete 2 keys the deploy writes for itself, so nothing was sent — no build emits such a key, so the document in the origin's deploy history that names it was not filed by an apply; replace that document with the manifest.json its build wrote, and the prune plans no DELETE for the key:",
    '  "/.pagedeck/manifests/build-x.json", named by "/.pagedeck/manifests/build-00.json"',
    '  "/manifest.json", named by "/.pagedeck/manifests/build-00.json"',
  ].join("\n");
  for (const apply of [true, false]) {
    const stub = stubFetch(() => new Response(null, { status: 200 }));
    let error: Error;
    try {
      error = await refusal(
        runDeploy(
          {
            to,
            source,
            origin: "(a presigned origin)",
            apply,
            pruneAfterUpload: true,
            now: PAST_GRACE,
            retention: { live: to, published: [planted] },
            presigned: { urls, reads: [], ...(apply ? {} : { requests: join(dir, "requests.json") }) },
          },
          () => undefined,
        ),
      );
    } finally {
      stub.restore();
    }
    expect(stub.calls).toEqual([]);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(expected);
  }
});

test("a prune withheld for a stated reason deletes nothing, lists no DELETE, and says why (#659)", async () => {
  const { to, source } = siteTree();
  const reason = "the reason the history could not be read";
  const requests = join(dir, "requests.json");
  const dry: string[] = [];
  await runDeploy(
    {
      to,
      source,
      origin: "(a presigned origin)",
      pruneAfterUpload: true,
      pruneWithheld: reason,
      presigned: { urls: await readDeployUrls(urlsFile({})), reads: [], requests },
    },
    (line) => dry.push(line),
  );
  expect((JSON.parse(readFileSync(requests, "utf8")) as { delete: object }).delete).toEqual({});
  expect(dry).toContain(`Prune: deletes nothing — ${reason}.`);

  const applied: string[] = [];
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  try {
    await runDeploy(
      {
        to,
        source,
        origin: "(a presigned origin)",
        apply: true,
        pruneAfterUpload: true,
        pruneWithheld: reason,
        presigned: { urls: await readDeployUrls(urlsFile({ put: allPuts() })), reads: [] },
      },
      (line) => applied.push(line),
    );
  } finally {
    stub.restore();
  }
  expect(stub.calls.map((call) => call.method)).not.toContain("DELETE");
  expect(applied.at(-1)).toBe(`Pruned nothing: ${reason}.`);
});

test("the history index is read with a signed GET, an origin without one reads as having none, and a bad one is refused unquoted (#659)", async () => {
  const urls = await readDeployUrls(urlsFile({ get: { [HISTORY_INDEX_KEY]: signed(HISTORY_INDEX_KEY) } }));
  for (const [status, body, expected] of [
    [200, '{"builds":["b1","b2"]}\n', ["b1", "b2"]],
    [404, "no", undefined],
  ] as const) {
    const stub = stubFetch(() => new Response(body, { status }));
    try {
      expect(await readSignedIndex(urls)).toEqual(expected);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toEqual([{ url: signed(HISTORY_INDEX_KEY), method: "GET", redirect: "manual" }]);
  }
  const stub = stubFetch(() => new Response('{"builds": ["../planted-text"]}', { status: 200 }));
  let error: Error;
  try {
    error = await refusal(readSignedIndex(urls));
  } finally {
    stub.restore();
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toMatch(/^Deploy history index "\/\.pagedeck\/deploy-history\.json": entry 1 is not a build id/);
  expect(error.message).not.toContain("planted-text");
});

test("a prune on an origin with no history index reads nothing more, and names the cause and the fix (#659)", async () => {
  const urls = await readDeployUrls(urlsFile({}));
  const stub = stubFetch(() => new Response(null, { status: 500 }));
  let history: Awaited<ReturnType<typeof readSignedHistory>>;
  try {
    history = await readSignedHistory(urls, undefined, { listUnsigned: false });
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([]);
  expect(history).toEqual({
    reads: [],
    withheld:
      'the origin holds no history index at "/.pagedeck/deploy-history.json", so this run cannot know which builds the origin served, and does not guess them — apply once with this pagedeck, which writes the index, and prune on a run after that; a file that only builds deployed before then named is never found, so delete it by hand if its bytes matter',
  });
});

test("a dry run listing requests names every history read the prune needs, and plans no DELETE until they are signed (#659)", async () => {
  const urls = await readDeployUrls(
    urlsFile({ get: { [MANIFEST_KEY]: signed(MANIFEST_KEY), [retainedKey("b1")]: signed(retainedKey("b1")) } }),
  );
  const stub = stubFetch(() => new Response(null, { status: 500 }));
  let history: Awaited<ReturnType<typeof readSignedHistory>>;
  try {
    history = await readSignedHistory(urls, ["b1", "b2"], { listUnsigned: true });
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([]);
  expect(history).toEqual({
    reads: [retainedKey("b1"), deployInstantKey("b1"), retainedKey("b2"), deployInstantKey("b2")],
    withheld:
      "the prune reads 3 keys of the origin's deploy history that PAGEDECK_DEPLOY_URLS holds no GET URL for, so this dry run plans no DELETE — sign the requests it wrote, and run the dry run again with the signed file to list the DELETEs",
  });

  const applying = await refusal(readSignedHistory(urls, ["b1", "b2"], { listUnsigned: false }));
  expect(applying).toBeInstanceOf(ConfigError);
  expect(applying.message).toContain('Deploy read of "/.pagedeck/manifests/b1.deployed-at": PAGEDECK_DEPLOY_URLS holds no GET URL for this key');
});

test("the history is read as the directory store reads it: a missing or unreadable document is left out, a missing instant falls back, a bad one is reported (#659)", async () => {
  const ids = ["build-00", "b2", "b3"];
  const keys = ids.flatMap((id) => [retainedKey(id), deployInstantKey(id)]);
  const urls = await readDeployUrls(urlsFile({ get: Object.fromEntries(keys.map((key) => [key, signed(key)])) }));
  const bodies = new Map<string, string>([
    [retainedKey("build-00"), JSON.stringify(OLD)],
    [deployInstantKey("build-00"), "2026-10-03T00:00:00Z\n"],
    [retainedKey("b3"), "not a manifest"],
    [deployInstantKey("b3"), "not an instant either"],
  ]);
  const stub = stubFetch((url) => {
    const key = new URL(url).pathname.slice("/site".length);
    const body = bodies.get(key);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  });
  let history: Awaited<ReturnType<typeof readSignedHistory>>;
  try {
    history = await readSignedHistory(urls, ids, { listUnsigned: true });
  } finally {
    stub.restore();
  }
  expect(stub.calls.map((call) => new URL(call.url).pathname.slice("/site".length))).toEqual([
    retainedKey("build-00"),
    deployInstantKey("build-00"),
    retainedKey("b2"),
    retainedKey("b3"),
  ]);
  expect(history.reads).toEqual(keys);
  expect(history.withheld).toBeUndefined();
  expect(history.retention?.published.map((one) => one.build.id)).toEqual(["build-00"]);
  expect(history.retention?.deployedAt).toEqual(new Map([["build-00", new Date("2026-10-03T00:00:00Z")]]));
  expect(history.retention?.unreadableDeployInstants).toEqual([]);

  bodies.set(deployInstantKey("build-00"), "yesterday");
  const again = stubFetch((url) => {
    const body = bodies.get(new URL(url).pathname.slice("/site".length));
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  });
  try {
    history = await readSignedHistory(urls, ids, { listUnsigned: false });
  } finally {
    again.restore();
  }
  expect(history.retention?.deployedAt).toEqual(new Map());
  expect(history.retention?.unreadableDeployInstants).toEqual([
    { key: deployInstantKey("build-00"), reason: "it holds no ISO-8601 instant" },
  ]);
});

test("a URL document key with a dot or empty segment, a backslash or a NUL is refused for every method (#659)", async () => {
  const file = urlsFile({
    get: { "/assets/../manifest.json": signed("/manifest.json") },
    put: { "/a//b.html": signed("/a//b.html") },
    delete: { "/assets/../index.html": signed("/index.html"), "/x\\y": signed("/x/y"), "/n\u0000ul": signed("/nul") },
  });
  const error = await refusal(readDeployUrls(file));
  expect(error).toBeInstanceOf(ConfigError);
  const rule = 'is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character';
  expect(error.message).toBe(
    [
      `Deploy URLs "${file}": 5 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:`,
      `  get "/assets/../manifest.json": ${rule}`,
      `  put "/a//b.html": ${rule}`,
      `  delete "/assets/../index.html": ${rule}`,
      `  delete "/x\\\\y": ${rule}`,
      `  delete "/n\uFFFDul": ${rule}`,
    ].join("\n"),
  );
  expect(error.message).not.toContain("X-Amz");
});

test("a history document naming a key that resolves to a live file is left out, so the prune plans no DELETE for it (#659)", async () => {
  const { to, source } = siteTree();
  const crafted = { ...OLD, files: [...OLD.files, { path: "/assets/../index.html", kind: "html", hash: "0", size: 1 }] };
  const keys = [retainedKey("build-00"), deployInstantKey("build-00")];
  const urls = await readDeployUrls(urlsFile({ get: Object.fromEntries(keys.map((key) => [key, signed(key)])) }));
  const stub = stubFetch((url) =>
    url.includes(".json") ? new Response(JSON.stringify(crafted), { status: 200 }) : new Response("no", { status: 404 }),
  );
  let history: Awaited<ReturnType<typeof readSignedHistory>>;
  try {
    history = await readSignedHistory(urls, ["build-00"], { listUnsigned: false });
  } finally {
    stub.restore();
  }
  expect(history.retention?.published).toEqual([]);
  const requests = join(dir, "requests.json");
  await runDeploy(
    {
      to,
      source,
      origin: "(a presigned origin)",
      pruneAfterUpload: true,
      now: PAST_GRACE,
      retention: { live: to, ...(history.retention ?? { published: [] }) },
      presigned: { urls, reads: [], requests },
    },
    () => undefined,
  );
  expect((JSON.parse(readFileSync(requests, "utf8")) as { delete: object }).delete).toEqual({});
});

test.each([
  ["CR", "\r"],
  ["LF", "\n"],
  ["ESC", "\u001b"],
  ["DEL", "\u007f"],
  ["U+0085", "\u0085"],
])("a history document whose file key holds a %s is left out of a presigned origin's history, so no plan line carries it (#674)", async (_name, control) => {
  const { to, source } = siteTree();
  const crafted = { ...OLD, files: [...OLD.files, { path: `/old${control}.txt`, kind: "asset", hash: "0", size: 1 }] };
  const keys = [retainedKey("build-00"), deployInstantKey("build-00")];
  const urls = await readDeployUrls(urlsFile({ get: Object.fromEntries(keys.map((key) => [key, signed(key)])) }));
  const stub = stubFetch((url) =>
    url.includes(".json") ? new Response(JSON.stringify(crafted), { status: 200 }) : new Response("no", { status: 404 }),
  );
  let history: Awaited<ReturnType<typeof readSignedHistory>>;
  try {
    history = await readSignedHistory(urls, ["build-00"], { listUnsigned: false });
  } finally {
    stub.restore();
  }
  const requests = join(dir, "requests.json");
  const lines: string[] = [];
  await runDeploy(
    {
      to,
      source,
      origin: "(a presigned origin)",
      pruneAfterUpload: true,
      now: PAST_GRACE,
      retention: { live: to, ...(history.retention ?? { published: [] }) },
      presigned: { urls, reads: [], requests },
    },
    (line) => lines.push(line),
  );
  expect(lines).toContainEqual(expect.stringMatching(/^ {2}\d+ to prune, /));
  expect(lines.filter((line) => line.includes(control))).toEqual([]);
  expect(history.retention?.published).toEqual([]);
});

test("a history index body larger than any index the caps admit is refused while it is read, naming the cap (#659)", async () => {
  expect(HISTORY_INDEX_MAX_BYTES).toBe(100_000 * (243 + 3) + '{"builds":[]}\n'.length);
  const urls = await readDeployUrls(urlsFile({ get: { [HISTORY_INDEX_KEY]: signed(HISTORY_INDEX_KEY) } }));
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let pulled = 0;
  const stub = stubFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      ),
  );
  let error: Error;
  try {
    error = await refusal(readSignedIndex(urls));
  } finally {
    stub.restore();
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    `Deploy history index "/.pagedeck/deploy-history.json": is larger than ${String(HISTORY_INDEX_MAX_BYTES)} bytes, the most an index of 100000 builds of 243-byte ids takes, so the rest was not read — rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named`,
  );
  expect(pulled).toBeLessThan(HISTORY_INDEX_MAX_BYTES / chunk.length + 4);
});

test("a DELETE with no URL in the file is refused naming the fix, and nothing is sent (#659)", async () => {
  const urls = await readDeployUrls(urlsFile({}));
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  let error: Error;
  try {
    error = await refusal(signedUrlTarget(urls).delete("/old.txt"));
  } finally {
    stub.restore();
  }
  expect(stub.calls).toEqual([]);
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    'Deploy of "/old.txt": PAGEDECK_DEPLOY_URLS holds no DELETE URL for this key — re-run the dry run with --prune and --requests, and sign every DELETE it lists',
  );
});
