import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MANIFEST_VERSION, RETENTION_DIR } from "@pagedeck/core";
import { checkLive, prepareRelease } from "./release.js";
import type { ReleaseRecord } from "./release.js";
import { BIN, serve, SITE as EXAMPLE, stop, WRANGLER } from "./wrangler.test-support.js";
import type { Served } from "./wrangler.test-support.js";

const run = promisify(execFile);

// Inside the example, so the copy resolves React, Hono and wrangler from its package; a copy
// of its own, so `site.build.test.ts` can build the example beside it.
const SITE = mkdtempSync(join(EXAMPLE, ".pagedeck-release-test-"));
// Outside the site, standing in for storage that outlives a CI runner.
const RELEASES = mkdtempSync(join(tmpdir(), "pagedeck-releases-"));
const BUNDLE = ["worker/app.js", "--no-bundle"];

const PAGE_B = "The second release.";
const THANKS_A = "Thanks. We will write to";
const THANKS_B = "Thanks again. We will write to";
const PENDING_A = "Signing up…";
const PENDING_B = "Signing you up…";

let served: Served | undefined;
let releaseA = "";
let releaseB = "";
let releaseC = "";
let onlyInB: string[] = [];

async function build(): Promise<void> {
  await run(process.execPath, [BIN, "sync"], { cwd: SITE });
  await run(process.execPath, [BIN, "build"], { cwd: SITE });
}

function edit(path: string, from: string, to: string): void {
  const file = join(SITE, path);
  const text = readFileSync(file, "utf8");
  expect(text, path).toContain(from);
  writeFileSync(file, text.replace(from, to));
}

function digests(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(root, file), createHash("sha256").update(readFileSync(file)).digest("hex")];
      })
      .sort(([a], [b]) => (a as string).localeCompare(b as string)),
  );
}

function signup(origin: string): Promise<Response> {
  return fetch(`${origin}/api/signup`, {
    method: "POST",
    headers: { Origin: origin, Accept: "application/json" },
    body: new URLSearchParams({ email: "reader@example.com" }),
  });
}

async function releaseServed(origin: string): Promise<unknown> {
  return ((await (await fetch(`${origin}/api/release`)).json()) as { release: unknown }).release;
}

async function swap(release: string): Promise<string> {
  await stop(served);
  served = await serve(join(RELEASES, release), BUNDLE);
  return served.origin;
}

beforeAll(async () => {
  for (const path of ["pagedeck.config.ts", "wrangler.jsonc", "favicon.ico", "content", "public"]) {
    cpSync(join(EXAMPLE, path), join(SITE, path), { recursive: true });
  }
  mkdirSync(join(SITE, "src"));
  cpSync(join(EXAMPLE, "src", "app.ts"), join(SITE, "src", "app.ts"));
  cpSync(join(EXAMPLE, "src", "components"), join(SITE, "src", "components"), { recursive: true });

  await build();
  releaseA = (await prepareRelease({ site: SITE, releases: RELEASES })).id;

  // Compatible: the same routes and the same shapes, with new text in the page, the island
  // and the app.
  edit("content/index.md", "This page is a static file.", `${PAGE_B} This page is a static file.`);
  edit("src/app.ts", THANKS_A, THANKS_B);
  edit("src/components/signup.tsx", PENDING_A, PENDING_B);
  await build();
  releaseB = (await prepareRelease({ site: SITE, releases: RELEASES })).id;

  const assetsOf = (id: string) => readdirSync(join(RELEASES, id, "site", "assets"));
  onlyInB = assetsOf(releaseB).filter((file) => !assetsOf(releaseA).includes(file));
}, 600_000);

afterAll(async () => {
  await stop(served);
  rmSync(SITE, { recursive: true, force: true });
  rmSync(RELEASES, { recursive: true, force: true });
});

test("a release holds the built tree, the site's wrangler.jsonc, the stamped app and its record", () => {
  const dir = join(RELEASES, releaseB);
  expect(readdirSync(dir).sort()).toEqual(["release.json", "site", "worker", "wrangler.jsonc"]);
  const record = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleaseRecord;
  const worker = readFileSync(join(dir, record.worker));
  expect(record).toEqual({
    release: releaseB,
    createdAt: expect.any(String) as string,
    parent: releaseA,
    worker: "worker/app.js",
    sha256: createHash("sha256").update(worker).digest("hex"),
    wrangler: JSON.parse(readFileSync(join(EXAMPLE, "node_modules", "wrangler", "package.json"), "utf8")).version as string,
  });
  expect(worker.toString()).toContain(JSON.stringify(releaseB));
  expect(readFileSync(join(dir, "wrangler.jsonc"), "utf8")).toBe(readFileSync(join(EXAMPLE, "wrangler.jsonc"), "utf8"));
  expect(digests(join(dir, "site"))).toEqual(digests(join(SITE, "site")));
  expect(onlyInB.length).toBeGreaterThan(0);
});

test("the second release serves its pages, island and app, and names itself", async () => {
  const origin = await swap(releaseB);
  expect(await releaseServed(origin)).toBe(releaseB);
  expect(await (await fetch(`${origin}/`)).text()).toContain(PAGE_B);
  expect(((await (await signup(origin)).json()) as { message: string }).message).toContain(THANKS_B);
  for (const file of onlyInB) expect((await fetch(`${origin}/assets/${file}`)).status, file).toBe(200);
}, 180_000);

test("a release that fails to bundle writes nothing, and leaves every release as it was", async () => {
  const before = digests(RELEASES);
  writeFileSync(join(SITE, "src", "app.ts"), `${readFileSync(join(SITE, "src", "app.ts"), "utf8")}\nexport const broken = ;\n`);
  await build();
  await expect(prepareRelease({ site: SITE, releases: RELEASES })).rejects.toThrow(
    /: wrangler could not bundle the app, so no release was written — fix the app until "wrangler deploy --dry-run" passes in /,
  );
  expect(digests(RELEASES)).toEqual(before);
  expect(readdirSync(RELEASES).filter((name) => name.startsWith("."))).toEqual([]);
  edit("src/app.ts", "\nexport const broken = ;\n", "");
}, 300_000);

test("a release built on the first while the second is live is refused, and the live release itself passes", async () => {
  const origin = served?.origin as string;
  // The retention store as a runner that never saw the second build would hold it.
  for (const name of readdirSync(join(SITE, RETENTION_DIR))) {
    if (name !== `${releaseA}.json`) rmSync(join(SITE, RETENTION_DIR, name));
  }
  edit("content/index.md", PAGE_B, "A third release.");
  await build();
  releaseC = (await prepareRelease({ site: SITE, releases: RELEASES })).id;

  await expect(checkLive({ releases: RELEASES, release: releaseC, live: origin })).rejects.toThrow(
    `Release "${releaseC}" over live release "${releaseB}": Manifest diff: build "${releaseC}" was built on "${releaseA}" and is being deployed over build "${releaseB}", so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy`,
  );
  await expect(checkLive({ releases: RELEASES, release: releaseB, live: origin })).resolves.toBeUndefined();
}, 300_000);

test("the first release restores from its directory alone, across a manifest version this pagedeck cannot read", async () => {
  // As if an older pagedeck had prepared it. Restoring reads no manifest.
  const manifest = join(RELEASES, releaseA, "site", "manifest.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"version": ${String(MANIFEST_VERSION)},`, `"version": ${String(MANIFEST_VERSION - 1)},`));
  for (const path of ["site", "content.db", ".pagedeck", "src"]) rmSync(join(SITE, path), { recursive: true, force: true });

  const dir = join(RELEASES, releaseA);
  const dryRun = await run(WRANGLER, ["deploy", "--dry-run", ...BUNDLE], {
    cwd: dir,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  expect(`${dryRun.stdout}${dryRun.stderr}`).toContain("--dry-run: exiting now.");

  const origin = await swap(releaseA);
  const record = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleaseRecord;
  expect(await releaseServed(origin)).toBe(record.release);
  expect(record.release).toBe(releaseA);

  const page = await fetch(`${origin}/`);
  const html = await page.text();
  expect(html).toContain("This page is a static file.");
  expect(html).not.toContain(PAGE_B);
  for (const [name, value] of [
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ]) {
    expect(page.headers.get(name as string), name).toBe(value);
  }

  for (const file of readdirSync(join(dir, "site", "assets"))) {
    const response = await fetch(`${origin}/assets/${file}`);
    expect(response.status, file).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(dir, "site", "assets", file))), file).toBe(true);
  }
  const island = readdirSync(join(dir, "site", "assets")).filter((file) =>
    readFileSync(join(dir, "site", "assets", file), "utf8").includes(PENDING_A),
  );
  expect(island).toHaveLength(1);

  const answer = await signup(origin);
  expect(((await answer.json()) as { message: string }).message).toContain(THANKS_A);
  expect(answer.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(answer.headers.get("Cache-Control")).toBe("no-store");
}, 300_000);

test("with the first release restored, the second's assets are gone and nothing private is served", async () => {
  const origin = served?.origin as string;
  for (const file of onlyInB) {
    const response = await fetch(`${origin}/assets/${file}`);
    expect(response.status, file).toBe(404);
    expect(response.headers.get("Cache-Control"), file).toBe("no-store");
  }
  for (const path of ["/manifest.json", "/_routes.json", "/.pagedeck/manifests", "/release.json", "/wrangler.jsonc", "/worker/app.js", "/.dev.vars"]) {
    expect((await fetch(`${origin}${path}`)).status, path).toBe(404);
  }
}, 30_000);

test("a release over a live release whose manifest cannot be read is refused, naming both versions", async () => {
  const origin = served?.origin as string;
  const error = await checkLive({ releases: RELEASES, release: releaseC, live: origin }).then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(error?.message).toBe(
    `Release "${releaseC}": the live release "${releaseA}" has a manifest this pagedeck cannot read, so nothing says what this release was built on — restoring "${releaseA}" needs no manifest; check what is live by hand, then pass --force`,
  );
  expect(String((error?.cause as Error).message)).toBe(
    `Manifest "${join(RELEASES, releaseA, "site", "manifest.json")}": is version ${String(MANIFEST_VERSION - 1)}, and this build reads version ${String(MANIFEST_VERSION)} — upgrade pagedeck, or read a manifest this version wrote`,
  );
  expect(existsSync(join(RELEASES, releaseC))).toBe(true);
}, 30_000);
