import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  buildManifest,
  EXIT_CODES,
  planEntries,
  planRouting,
  planTiers,
} from "@pagedeck/core";
import type { Page } from "@pagedeck/core";

const BIN = join(import.meta.dirname, "..", "dist", "deploy.bin.js");
const SECRET = "X-Amz-Signature=deadbeefsecret";
// `.invalid` never resolves (RFC 2606), so a request that should not be sent fails
// as a request rather than passing as a refusal.
const signed = (key: string): string => `https://origin.invalid/site${key}?${SECRET}`;

let dir: string;
let out: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pagedeck-deploy-bin-"));
  out = join(dir, "site");
  mkdirSync(out);
  const home: Page = { locale: "en", path: "/", output: "/", dependencies: [] };
  const entries = planEntries([{ page: home, islands: [] }], { modules: {} });
  const manifest = buildManifest({
    build: { id: "build-01", createdAt: "2026-10-02T10:00:00.000Z" },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [home], trailingSlash: "never" }),
    pages: [home],
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs: [{ path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: "home" }],
  });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(out, "index.html"), "home");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function urlsFile(name: string, document: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
  return file;
}

async function deploy(
  argv: string[],
  urls?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PAGEDECK_DEPLOY_URLS;
  if (urls !== undefined) env.PAGEDECK_DEPLOY_URLS = urls;
  return await new Promise((resolve) => {
    execFile(process.execPath, [BIN, "--out", out, ...argv], { env, cwd: dir }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
    });
  });
}

function expectNoCredential(run: { stdout: string; stderr: string }): void {
  for (const text of [run.stdout, run.stderr]) {
    expect(text).not.toContain("X-Amz");
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("origin.invalid/site");
  }
}

test("PAGEDECK_DEPLOY_URLS and --origin together are refused rather than ranked", async () => {
  const file = urlsFile("both.json", { get: { "/manifest.json": signed("/manifest.json") } });
  const run = await deploy(["--origin", join(dir, "origin")], file);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain(
    `Option "--origin" and PAGEDECK_DEPLOY_URLS are both given, as "${join(dir, "origin")}" and "${file}" — two sources for one origin are refused rather than ranked; pass one.`,
  );
  expect(run.stdout).toBe("");
}, 30_000);

test("neither --origin nor PAGEDECK_DEPLOY_URLS is a usage error naming both", async () => {
  const run = await deploy([]);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain("No --origin given, and PAGEDECK_DEPLOY_URLS is not set.");
}, 30_000);

test("an --edge target no adapter names is refused, naming every one there is", async () => {
  const run = await deploy(["--origin", join(dir, "origin"), "--edge", "fastly"]);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain(
    'Edge target "fastly" is not supported — use one of: cloudfront-function, netlify, nginx, cloudflare-worker',
  );
}, 30_000);

test("--prune against a presigned origin is taken, and the run goes on to read the origin (#659)", async () => {
  const file = urlsFile("prune.json", { get: { "/manifest.json": signed("/manifest.json") } });
  const run = await deploy(["--apply", "--prune"], file);
  expect(run.code).toBe(EXIT_CODES.syncFailed);
  expect(run.stderr).not.toContain('Option "--prune"');
  expect(run.stderr).toContain('Deploy read of "/manifest.json": the request failed');
  expectNoCredential(run);
}, 30_000);

test("--requests is refused beside --apply, and without a presigned origin", async () => {
  const file = urlsFile("requests.json", { get: { "/manifest.json": signed("/manifest.json") } });
  const applying = await deploy(["--apply", "--requests", join(dir, "r.json")], file);
  expect(applying.code).toBe(EXIT_CODES.configError);
  expect(applying.stderr).toContain(
    'Options "--requests" and "--apply" are given together — --requests lists what a dry run would ask the signing step for, and an apply signs nothing; drop one.',
  );
  const directory = await deploy(["--origin", join(dir, "origin"), "--requests", join(dir, "r.json")]);
  expect(directory.code).toBe(EXIT_CODES.configError);
  expect(directory.stderr).toContain(
    'Option "--requests" is given without PAGEDECK_DEPLOY_URLS — it lists the requests a presigned origin needs signed, and a directory origin needs none; set PAGEDECK_DEPLOY_URLS, or drop "--requests".',
  );
}, 30_000);

test("--requests naming the URL file itself is refused, so the dry run cannot write over it", async () => {
  const file = urlsFile("same.json", { get: { "/manifest.json": signed("/manifest.json") } });
  const link = join(dir, "same-link.json");
  symlinkSync(file, link);
  for (const requests of [file, link]) {
    const run = await deploy(["--requests", requests], file);
    expect(run.code).toBe(EXIT_CODES.configError);
    expect(run.stderr).toContain(
      `Option "--requests" names ${JSON.stringify(requests)}, which is the file PAGEDECK_DEPLOY_URLS names — the dry run would write the requests over the presigned URLs; write the requests to another file.`,
    );
    expect(readFileSync(file, "utf8")).toContain("X-Amz");
  }
}, 30_000);

test("http: and loopback URLs are refused before any request, and no URL reaches the output", async () => {
  const file = urlsFile("local.json", {
    get: { "/manifest.json": `http://origin.invalid/site/manifest.json?${SECRET}` },
    put: { "/index.html": `https://127.0.0.1/site/index.html?${SECRET}` },
  });
  const run = await deploy(["--apply"], file);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain('get "/manifest.json": is a http: URL');
  expect(run.stderr).toContain('put "/index.html": names a loopback host');
  expectNoCredential(run);
}, 30_000);

test("a URL with a user name and password is refused before any request, and neither reaches stderr", async () => {
  const file = urlsFile("userinfo.json", {
    get: { "/manifest.json": `https://AKIAUSER:hunter2pass@origin.invalid/site/manifest.json?${SECRET}` },
  });
  const run = await deploy([], file);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain('get "/manifest.json": carries a user name or password before its host');
  for (const text of [run.stdout, run.stderr]) {
    expect(text).not.toContain("AKIAUSER");
    expect(text).not.toContain("hunter2pass");
  }
  expectNoCredential(run);
}, 30_000);

test("a URL file that is not JSON is refused with none of its text", async () => {
  const file = urlsFile("broken.json", `{"get": {"/manifest.json": "${signed("/manifest.json")}"`);
  const run = await deploy([], file);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain("is not valid JSON");
  expectNoCredential(run);
}, 30_000);

test("a request that fails names the key, exits 1, and prints no URL", async () => {
  const file = urlsFile("unreachable.json", { get: { "/manifest.json": signed("/manifest.json") } });
  const run = await deploy([], file);
  expect(run.code).toBe(EXIT_CODES.syncFailed);
  expect(run.stderr).toContain(
    'Deploy read of "/manifest.json": the request failed — check that the origin is reachable from this runner. The URL is not printed: it carries the credential in its query string.',
  );
  expectNoCredential(run);
}, 30_000);

test("a rollback whose --out tree is another build is refused before any request", async () => {
  const file = urlsFile("rollback.json", {
    get: {
      "/manifest.json": signed("/manifest.json"),
      "/.pagedeck/manifests/build-00.json": signed("/.pagedeck/manifests/build-00.json"),
    },
  });
  const run = await deploy(["--rollback", "build-00"], file);
  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.stderr).toContain(
    `Rollback to build "build-00": the tree at "${out}" is build "build-01", and a rollback uploads the restored build's own bytes from that tree — pass --out the tree build "build-00" wrote.`,
  );
  expectNoCredential(run);
}, 30_000);
