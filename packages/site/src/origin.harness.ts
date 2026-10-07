import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES, fileKey, readManifest, runCli } from "@pagedeck/core";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";
import { runWorker } from "../../adapter-cloudflare-worker/src/worker.test-support.js";
import type { OriginBinding } from "../../adapter-cloudflare-worker/src/worker.test-support.js";
import type { Manifest } from "@pagedeck/core";
import { deployInstantKey, HISTORY_INDEX_KEY, MANIFEST_KEY, presignedTarget, retainedKey } from "./deploy-target.js";
import type { DeployTarget } from "./deploy-target.js";
import { documentMetadata } from "./deploy-metadata.js";
import { credentialLeaks, DEPLOY_BIN, runDeployCli, signedDeploy, signUrls } from "./deploy-cli.test-support.js";
import type { CliRun } from "./deploy-cli.test-support.js";
import {
  caTrustUnavailable,
  dockerUnavailable,
  opensslUnavailable,
  ORIGIN_IP,
  startS3Origin,
} from "./s3-origin.test-support.js";
import type { S3Origin } from "./s3-origin.test-support.js";
import { objectPath, presign, signedFetch } from "./sigv4.test-support.js";

const CORE = join(import.meta.dirname, "..", "..", "core", "src");
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "src", "index.ts");
// Under `node_modules`, so an interrupted run cannot be committed.
const SITE = fileURLToPath(new URL("../node_modules/.pagedeck-origin-harness", import.meta.url));
const OUT = join(SITE, "dist");
// `pagedeck build` retains a manifest, not the bytes, so the rollback's tree is kept here.
const FIRST_TREE = join(SITE, "first-build");
const STORE = join(SITE, "content.db");

const BUCKET = "site";
const SNAPSHOT_KEY = "snapshots/content.db";

const HOME_ONE = "Home, first build";
const HOME_TWO = "Home, second build";
const PRICING = "Pricing, unchanged in both builds";
const DOMAIN = "de.test";

function writeEntry(path: string, rev: number, title: string, locale = "en"): void {
  const file = join(SITE, "content", locale, `${path}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ rev, data: { title } })}\n`);
}

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });
  mkdirSync(join(SITE, "public"));
  writeFileSync(
    join(SITE, "components", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );
  writeEntry("home", 1, HOME_ONE);
  writeEntry("pricing", 1, PRICING);
  writeEntry("home", 1, "Startseite", "de");
  writeEntry("kontakt", 1, "Kontakt, only in the domain tree", "de");
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    passthrough: { root: "./public" },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "en", direction: "ltr" },
        de: { label: "de", direction: "ltr", domain: ${JSON.stringify(DOMAIN)} },
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: { Prose: "./components/Prose.js" },
    content: (page, store) => ({
      tree: [
        {
          component: "Prose",
          props: { text: store.getEntry("pages", page.locale, page.entry.path).data.title },
        },
      ],
    }),
  },
});
`,
  );
}

async function pagedeck(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: SITE,
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

async function build(): Promise<Manifest> {
  for (const verb of ["sync", "build"]) {
    const run = await pagedeck([verb]);
    if (run.code !== EXIT_CODES.success) {
      throw new Error(
        `Origin harness: pagedeck ${verb} failed on the fixture site in "${SITE}" — fix what pagedeck ${verb} reports below, then re-run pnpm test:origin-harness:\n${run.err.join("\n")}`,
      );
    }
  }
  const file = join(OUT, "manifest.json");
  return readManifest(readFileSync(file, "utf8"), file);
}

const objectKey = (key: string): string => key.replace(/^\//, "");

const expectedBytes = (root: string, file: Manifest["files"][number]): Buffer =>
  readFileSync(join(root, file.domain ?? "", file.path));

const PRESIGN_BIN = join(import.meta.dirname, "..", "dist", "presign.bin.js");

const unavailable = caTrustUnavailable() ?? (await opensslUnavailable()) ?? (await dockerUnavailable());
if (unavailable !== undefined) console.warn(`[#302] origin harness skipped: ${unavailable}`);

describe.skipIf(unavailable !== undefined)(
  `presigned deploy against a SeaweedFS S3 origin${unavailable === undefined ? "" : ` (skipped: ${unavailable})`}`,
  () => {
    let origin: S3Origin;
    let first: Manifest;

    const url = (method: string, key: string): string =>
      presign({ ...origin, bucket: BUCKET, key: objectKey(key), method });

    const target = (): DeployTarget =>
      presignedTarget({ put: (key) => url("PUT", key), delete: (key) => url("DELETE", key) });

    const read = (key: string): Promise<Response> =>
      signedFetch({ ...origin, path: objectPath(BUCKET, objectKey(key)) });

    beforeAll(async () => {
      writeSite();
      origin = await startS3Origin();
      const bucket = await signedFetch({ ...origin, path: `/${BUCKET}`, method: "PUT" });
      expect(bucket.status).toBe(200);
      first = await build();
      cpSync(OUT, FIRST_TREE, { recursive: true });
    }, 600_000);

    afterAll(async () => {
      rmSync(SITE, { recursive: true, force: true });
      if (origin === undefined) return;
      const { container, network } = origin;
      await origin.stop();
      const exists = (args: string[]): Promise<boolean> =>
        new Promise((resolve) => {
          execFile("docker", args, (error) => {
            resolve(error === null);
          });
        });
      expect(await exists(["container", "inspect", container])).toBe(false);
      expect(await exists(["network", "inspect", network])).toBe(false);
    }, 120_000);

    test("the origin is served over TLS at a fixed address that is not loopback", async () => {
      const endpoint = new URL(origin.endpoint);
      expect(endpoint.protocol).toBe("https:");
      expect(endpoint.hostname).toBe(ORIGIN_IP);
      expect(endpoint.hostname).not.toMatch(/^127\.|^localhost$/);
      expect((await fetch(`${origin.endpoint}/healthz`)).status).toBe(200);
    });

    const signing = (): { origin: S3Origin; bucket: string; dir: string } => ({ origin, bucket: BUCKET, dir: SITE });
    const live = async (): Promise<Manifest> => {
      const response = await read(MANIFEST_KEY);
      expect(response.status).toBe(200);
      return readManifest(await response.text(), `${origin.endpoint}${MANIFEST_KEY}`);
    };

    test("a first deploy by the spawned CLI puts bytes identical to the build, and no credential reaches argv or output", async () => {
      const started = performance.now();
      const run = await signedDeploy(signing(), ["--out", OUT], [MANIFEST_KEY, HISTORY_INDEX_KEY]);
      const elapsed = performance.now() - started;
      expect(run.dry.stderr).toBe("");
      expect(run.dry.code).toBe(EXIT_CODES.success);
      expect(run.dry.stdout).toContain("(first deploy)");
      expect(run.apply?.stderr).toBe("");
      expect(run.apply?.code).toBe(EXIT_CODES.success);
      expect(credentialLeaks(origin, [run.dry, run.apply])).toEqual([]);
      const { puts } = run;
      expect(puts.slice(0, -4).sort()).toEqual(first.files.map((file) => fileKey(file.domain, file.path)).sort());
      expect(puts.slice(-4)).toEqual([
        retainedKey(first.build.id),
        deployInstantKey(first.build.id),
        HISTORY_INDEX_KEY,
        MANIFEST_KEY,
      ]);
      expect(run.apply?.stdout).toContain(`Uploaded ${String(puts.length - 3)} files to presigned https target.`);
      expect(await (await read(HISTORY_INDEX_KEY)).text()).toBe(`{"builds":[${JSON.stringify(first.build.id)}]}\n`);

      const keys = first.files.map((file) => fileKey(file.domain, file.path));
      expect(keys).toContain(`//${DOMAIN}/index.html`);
      expect(keys).toContain(`//${DOMAIN}/kontakt/index.html`);
      expect(keys).not.toContain("/kontakt/index.html");
      for (const file of first.files) {
        const key = fileKey(file.domain, file.path);
        const response = await read(key);
        expect(response.status, key).toBe(200);
        const served = Buffer.from(await response.arrayBuffer());
        expect(served.equals(expectedBytes(OUT, file)), key).toBe(true);
      }
      expect((await live()).build.id).toBe(first.build.id);
      console.log(
        `[#652] first deploy: ${String(puts.length)} presigned PUTs by the spawned CLI, both passes in ${elapsed.toFixed(0)} ms (a LAN round trip, not publish-to-live)`,
      );
    }, 120_000);

    test("a second deploy by the spawned CLI reads the live manifest off the origin and uploads only what changed", async () => {
      writeEntry("home", 2, HOME_TWO);
      const second = await build();

      const started = performance.now();
      const run = await signedDeploy(signing(), ["--out", OUT], [MANIFEST_KEY, HISTORY_INDEX_KEY]);
      const elapsed = performance.now() - started;
      expect(run.dry.code).toBe(EXIT_CODES.success);
      expect(run.dry.stdout).toContain(`Deploy ${first.build.id} -> ${second.build.id}`);
      expect(run.apply?.stderr).toBe("");
      expect(run.apply?.code).toBe(EXIT_CODES.success);
      expect(credentialLeaks(origin, [run.dry, run.apply])).toEqual([]);
      // Derived rather than listed, so a fixture file a title edit also rewrites (a search
      // index, a sitemap) does not fail this.
      const before = new Map(first.files.map((file) => [fileKey(file.domain, file.path), file.hash]));
      const changed = second.files
        .map((file) => ({ key: fileKey(file.domain, file.path), hash: file.hash }))
        .filter((file) => before.get(file.key) !== file.hash)
        .map((file) => file.key);
      expect(changed).toContain("/index.html");
      const { puts } = run;
      expect(puts.slice(0, -4).sort()).toEqual([...changed].sort());
      expect(puts.slice(-4)).toEqual([
        retainedKey(second.build.id),
        deployInstantKey(second.build.id),
        HISTORY_INDEX_KEY,
        MANIFEST_KEY,
      ]);
      expect(await (await read(HISTORY_INDEX_KEY)).text()).toBe(
        `{"builds":${JSON.stringify([first.build.id, second.build.id].sort())}}\n`,
      );
      expect(puts).not.toContain("/pricing/index.html");
      const home = await read("/index.html");
      expect(await home.text()).toContain(HOME_TWO);
      expect((await live()).build.id).toBe(second.build.id);
      const pricing = (build: Manifest): string | undefined =>
        build.files.find((file) => file.path === "/pricing/index.html")?.hash;
      expect(pricing(second)).toBeDefined();
      expect(pricing(second)).toBe(pricing(first));
      console.log(`[#652] incremental deploy: ${String(puts.length)} presigned PUTs by the spawned CLI in ${elapsed.toFixed(0)} ms`);
    }, 180_000);

    test("a rollback by the spawned CLI reads the retained manifest off the origin's history and serves the first build again", async () => {
      const history = retainedKey(first.build.id);
      const run = await signedDeploy(
        signing(),
        ["--out", FIRST_TREE, "--rollback", first.build.id],
        [MANIFEST_KEY, HISTORY_INDEX_KEY, history],
      );
      expect(run.dry.stderr).toBe("");
      expect(run.dry.code).toBe(EXIT_CODES.success);
      expect(run.dry.stdout).toContain(`-> ${first.build.id}`);
      expect(run.apply?.stderr).toBe("");
      expect(run.apply?.code).toBe(EXIT_CODES.success);
      expect(credentialLeaks(origin, [run.dry, run.apply])).toEqual([]);
      expect(run.puts).toContain("/index.html");
      expect(run.puts).not.toContain("/pricing/index.html");
      expect((await live()).build.id).toBe(first.build.id);
      expect(await (await read("/index.html")).text()).toContain(HOME_ONE);
      for (const file of first.files) {
        const key = fileKey(file.domain, file.path);
        const served = Buffer.from(await (await read(key)).arrayBuffer());
        expect(served.equals(expectedBytes(FIRST_TREE, file)), key).toBe(true);
      }
    }, 120_000);

    test("a presigned DELETE removes the object: 200 before, 404 after", async () => {
      const key = "/delete-me.txt";
      await target().put(key, Buffer.from("going\n"), documentMetadata(key));
      expect((await read(key)).status).toBe(200);
      await target().delete(key);
      expect((await read(key)).status).toBe(404);
    });

    test("an origin error is the origin's real status, exits 1, and no credential reaches argv or output", async () => {
      const wrong = "not-the-secret-this-host-knows";
      const refused = await signedDeploy({ ...signing(), putSecret: wrong }, ["--out", OUT], [MANIFEST_KEY, HISTORY_INDEX_KEY]);
      expect(refused.dry.code).toBe(EXIT_CODES.success);
      expect(refused.apply?.code).toBe(EXIT_CODES.syncFailed);
      expect(refused.apply?.stdout).not.toContain("Uploaded");
      expect(refused.apply?.stderr).toMatch(/^Deploy of "\/[^"]+": the host answered 403 to PUT — re-presign the URL/);

      const unreadable = await runDeployCli(
        signing(),
        ["--out", OUT],
        signUrls({ ...signing(), origin: { ...origin, secretKey: wrong } }, "wrong-read.json", { get: [MANIFEST_KEY] }),
      );
      expect(unreadable.code).toBe(EXIT_CODES.syncFailed);
      expect(unreadable.stderr).toContain('Deploy read of "/manifest.json": the host answered 403 to GET — re-presign the URL');

      for (const run of [refused.dry, refused.apply, unreadable]) {
        for (const text of [run?.stdout ?? "", run?.stderr ?? ""]) {
          expect(text).not.toContain(wrong);
          expect(text).not.toContain(ORIGIN_IP);
        }
      }
      expect(credentialLeaks(origin, [refused.dry, refused.apply, unreadable])).toEqual([]);
      expect((await live()).build.id).toBe(first.build.id);
    }, 60_000);

    test("an http: presigned URL is refused before anything reaches the origin", async () => {
      const key = "/never-sent.txt";
      const plain = presignedTarget({
        put: (one) => url("PUT", one).replace(/^https:/, "http:"),
        delete: (one) => url("DELETE", one).replace(/^https:/, "http:"),
      });
      await expect(plain.put(key, Buffer.from("x"), documentMetadata(key))).rejects.toThrow(
        `Deploy of "${key}": the presigned URL is a http: URL, and a deploy sends bytes only over https — presign it over https, the scheme pagedeck store push already requires`,
      );
      expect((await read(key)).status).toBe(404);
    });

    test("the spawned CLI refuses http: and loopback URLs before any request, so the origin is untouched", async () => {
      const keys = { get: [MANIFEST_KEY], put: [MANIFEST_KEY] };
      const signed = JSON.parse(readFileSync(signUrls(signing(), "plain.json", keys), "utf8")) as {
        get: Record<string, string>;
        put: Record<string, string>;
      };
      const rewrite = (name: string, change: (url: string) => string): string => {
        const file = join(SITE, name);
        writeFileSync(
          file,
          JSON.stringify({
            get: { [MANIFEST_KEY]: change(signed.get[MANIFEST_KEY] as string) },
            put: { [MANIFEST_KEY]: change(signed.put[MANIFEST_KEY] as string) },
          }),
        );
        return file;
      };
      const plain = await runDeployCli(signing(), ["--out", OUT, "--apply"], rewrite("http.json", (one) => one.replace(/^https:/, "http:")));
      const loopback = await runDeployCli(signing(), ["--out", OUT, "--apply"], rewrite("loopback.json", (one) => one.replace(ORIGIN_IP, "127.0.0.1")));
      expect(plain.code).toBe(EXIT_CODES.configError);
      expect(plain.stderr).toContain('get "/manifest.json": is a http: URL');
      expect(loopback.code).toBe(EXIT_CODES.configError);
      expect(loopback.stderr).toContain('put "/manifest.json": names a loopback host');
      expect(plain.stdout + loopback.stdout).toBe("");
      expect(credentialLeaks(origin, [plain, loopback])).toEqual([]);
      expect((await live()).build.id).toBe(first.build.id);
    }, 60_000);

    test("pagedeck store push and pull round-trip the store, and the printed target has no query string", async () => {
      const saved = `${STORE}.saved`;
      copyFileSync(STORE, saved);
      const bare = `${origin.endpoint}${objectPath(BUCKET, SNAPSHOT_KEY)}`;

      const push = await pagedeck(["store", "push"], {
        PAGEDECK_SNAPSHOT_URL: presign({ ...origin, bucket: BUCKET, key: SNAPSHOT_KEY, method: "PUT" }),
      });
      expect(push.err).toEqual([]);
      expect(push.code).toBe(EXIT_CODES.success);
      expect(push.out).toEqual([`pushed snapshot from ${STORE} to ${bare}`]);
      expect(push.out.join("\n")).not.toMatch(/\?|X-Amz-/);

      rmSync(STORE);
      const pull = await pagedeck(["store", "pull"], {
        PAGEDECK_SNAPSHOT_URL: presign({ ...origin, bucket: BUCKET, key: SNAPSHOT_KEY, method: "GET" }),
      });
      expect(pull.err).toEqual([]);
      expect(pull.code).toBe(EXIT_CODES.success);
      expect(pull.out).toEqual([`pulled snapshot from ${bare} to ${STORE}`]);
      expect(readFileSync(STORE).equals(readFileSync(saved))).toBe(true);
      rmSync(saved);
    }, 60_000);

    test("the R2 signing step's URLs, region auto, carry both passes of the spawned CLI, and the compiled Worker serves what they put", async () => {
      const bucket = "landing";
      expect((await signedFetch({ ...origin, path: `/${bucket}`, method: "PUT" })).status).toBe(200);
      const credential = {
        PAGEDECK_S3_ENDPOINT: origin.endpoint,
        PAGEDECK_S3_REGION: "auto",
        PAGEDECK_S3_BUCKET: bucket,
        PAGEDECK_S3_ACCESS_KEY_ID: origin.accessKey,
        PAGEDECK_S3_SECRET_ACCESS_KEY: origin.secretKey,
      };
      const presign = (requests: string, signed: string): Promise<CliRun> =>
        new Promise((resolve) => {
          const argv = [requests, signed];
          execFile(
            process.execPath,
            [PRESIGN_BIN, ...argv],
            { cwd: SITE, env: { ...process.env, ...credential } },
            (error, stdout, stderr) => {
              resolve({ argv, code: error === null ? 0 : Number(error.code), stdout, stderr });
            },
          );
        });
      const staging = join(SITE, "r2-staging");
      const edge = ["--edge", "cloudflare-worker", "--staging", staging];

      writeFileSync(join(SITE, "r2-reads.json"), JSON.stringify({ get: { [MANIFEST_KEY]: {}, [HISTORY_INDEX_KEY]: {} } }));
      const readsSigned = await presign("r2-reads.json", "r2-reads-signed.json");
      expect(readsSigned.code).toBe(EXIT_CODES.success);
      const dry = await runDeployCli(signing(), ["--out", OUT, ...edge, "--requests", "r2-requests.json"], join(SITE, "r2-reads-signed.json"));
      expect(dry.stderr).toBe("");
      expect(dry.code).toBe(EXIT_CODES.success);
      expect(dry.stdout).toContain("(first deploy)");
      const allSigned = await presign("r2-requests.json", "r2-signed.json");
      expect(allSigned.code).toBe(EXIT_CODES.success);
      const apply = await runDeployCli(signing(), ["--out", OUT, ...edge, "--apply"], join(SITE, "r2-signed.json"));
      expect(apply.stderr).toBe("");
      expect(apply.code).toBe(EXIT_CODES.success);
      expect(credentialLeaks(origin, [readsSigned, dry, allSigned, apply])).toEqual([]);
      for (const run of [readsSigned, allSigned]) expect(run.stdout + run.stderr).not.toContain(ORIGIN_IP);

      const built = readManifest(readFileSync(join(OUT, "manifest.json"), "utf8"), join(OUT, "manifest.json"));
      const read = (key: string): Promise<Response> => signedFetch({ ...origin, path: objectPath(bucket, key) });
      for (const file of built.files) {
        const key = fileKey(file.domain, file.path);
        const response = await read(objectKey(key));
        expect(response.status, key).toBe(200);
        expect(Buffer.from(await response.arrayBuffer()).equals(expectedBytes(OUT, file)), key).toBe(true);
      }

      const worker = readFileSync(join(staging, "worker.js"), "utf8");
      const compiled = cloudflareWorker().compile(built.routing).artifacts;
      expect(worker).toBe(compiled.find((artifact) => artifact.domain === undefined)?.contents);
      const binding: OriginBinding = {
        async get(key) {
          const response = await read(key);
          if (response.status === 404) return null;
          expect(response.status, key).toBe(200);
          const bytes = Buffer.from(await response.arrayBuffer());
          return {
            key,
            body: new Blob([bytes]).stream(),
            text: () => Promise.resolve(bytes.toString("utf8")),
            httpEtag: response.headers.get("etag") ?? "",
            uploaded: new Date(response.headers.get("last-modified") ?? 0),
            writeHttpMetadata(headers) {
              const type = response.headers.get("content-type");
              if (type !== null) headers.set("content-type", type);
              const cache = response.headers.get("cache-control");
              if (cache !== null) headers.set("cache-control", cache);
            },
          };
        },
      };
      const serve = (path: string): Promise<Response> =>
        runWorker(worker, { method: "GET", url: `https://landing.test${path}` }, binding);
      for (const [path, file] of [["/", "index.html"], ["/pricing", "pricing/index.html"]] as const) {
        const response = await serve(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
        expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(OUT, file))), path).toBe(true);
      }
      for (const path of ["/manifest.json", `/.pagedeck/manifests/${built.build.id}.json`, "/en/../manifest.json"]) {
        expect((await serve(path)).status, path).toBe(404);
      }
      console.log(
        `[#665] R2 signer: ${String(Object.keys((JSON.parse(readFileSync(join(SITE, "r2-requests.json"), "utf8")) as { put: object }).put).length)} PUTs signed in region auto, served back through the compiled Worker`,
      );
    }, 180_000);

    test("the loopback refusal still fires, so this carve-out cannot silently widen", async () => {
      // The same presigned URL, pointed at loopback. The bridge address above
      // is taken because it is a private range; this one never is.
      const signed = presign({ ...origin, bucket: BUCKET, key: SNAPSHOT_KEY, method: "PUT" });
      const loopback = signed.replace(ORIGIN_IP, "127.0.0.1");
      const push = await pagedeck(["store", "push"], { PAGEDECK_SNAPSHOT_URL: loopback });
      expect(push.code).toBe(EXIT_CODES.configError);
      expect(push.out).toEqual([]);
      expect(push.err.join("\n")).toContain(
        `Snapshot target "https://127.0.0.1:9000${objectPath(BUCKET, SNAPSHOT_KEY)}": host "127.0.0.1" is a loopback host — no snapshot is served from this runner or its link, and a push to one would PUT the site's whole content store to whatever the target names; point the target at the host the snapshot lives on`,
      );
      expect(push.err.join("\n")).not.toMatch(/X-Amz-/);
    });

    // Its own bucket and fixture edits, after every test above has read the tree it built.
    describe("the prune through the history index (#659)", () => {
      const bucket = "prune";
      const DIRECTORY = join(SITE, "prune-origin");
      const pruning = (): { origin: S3Origin; bucket: string; dir: string } => ({ origin, bucket, dir: SITE });
      const readKey = (key: string): Promise<Response> =>
        signedFetch({ ...origin, path: objectPath(bucket, objectKey(key)) });
      const putKey = async (key: string, body: string): Promise<void> => {
        const response = await signedFetch({ ...origin, path: objectPath(bucket, objectKey(key)), method: "PUT", body: Buffer.from(body) });
        expect(response.status, key).toBe(200);
      };
      const builds: Manifest[] = [];
      const keysOf = (build: Manifest): string[] => build.files.map((file) => fileKey(file.domain, file.path));
      const writePublic = (name: string | undefined): void => {
        rmSync(join(SITE, "public"), { recursive: true, force: true });
        mkdirSync(join(SITE, "public"));
        if (name !== undefined) writeFileSync(join(SITE, "public", name), `${name}\n`);
      };
      const directoryDeploy = (argv: readonly string[]): Promise<CliRun> =>
        new Promise((resolve) => {
          const env = { ...process.env };
          delete env.PAGEDECK_DEPLOY_URLS;
          const all = ["--out", OUT, "--origin", DIRECTORY, ...argv];
          execFile(process.execPath, [DEPLOY_BIN, ...all], { cwd: SITE, env }, (error, stdout, stderr) => {
            resolve({ argv: all, code: error === null ? 0 : Number(error.code), stdout, stderr });
          });
        });
      // The files a run says it pruned, in the order it printed them.
      const pruned = (run: CliRun | undefined): string[] =>
        (run?.stdout ?? "")
          .split("\n")
          .filter((line) => line.startsWith("    prune  "))
          .map((line) => line.slice("    prune  ".length));
      // Every key any build or the history named, and whether each origin still holds it.
      const holdings = async (): Promise<{ presigned: string[]; directory: string[] }> => {
        const keys = new Set([MANIFEST_KEY, HISTORY_INDEX_KEY]);
        for (const build of builds) {
          for (const key of [...keysOf(build), retainedKey(build.build.id), deployInstantKey(build.build.id)]) keys.add(key);
        }
        const presigned: string[] = [];
        const directory: string[] = [];
        for (const key of [...keys].sort()) {
          const status = (await readKey(key)).status;
          expect([200, 404], key).toContain(status);
          if (status === 200) presigned.push(key);
          if (existsSync(join(DIRECTORY, objectKey(key)))) directory.push(key);
        }
        return { presigned, directory };
      };
      const backdate = async (id: string, days: number): Promise<void> => {
        const instant = `${new Date(Date.now() - days * 86_400_000).toISOString()}\n`;
        await putKey(deployInstantKey(id), instant);
        writeFileSync(join(DIRECTORY, objectKey(deployInstantKey(id))), instant);
      };

      test("three builds deployed to a presigned origin and to a directory origin, then pruned: the same files go from both, and the live build stays", async () => {
        expect((await signedFetch({ ...origin, path: `/${bucket}`, method: "PUT" })).status).toBe(200);
        const runs: (CliRun | undefined)[] = [];
        const deployBoth = async (): Promise<void> => {
          const signed = await signedDeploy(pruning(), ["--out", OUT], [MANIFEST_KEY, HISTORY_INDEX_KEY]);
          expect(signed.dry.stderr).toBe("");
          expect(signed.apply?.stderr).toBe("");
          expect(signed.apply?.code).toBe(EXIT_CODES.success);
          const directory = await directoryDeploy(["--apply"]);
          expect(directory.stderr).toBe("");
          expect(directory.code).toBe(EXIT_CODES.success);
          runs.push(signed.dry, signed.apply);
        };

        // b1 serves /about and notes-1.txt; b2 drops both; b3 swaps notes-2.txt for notes-3.txt.
        writeEntry("about", 1, "About, first build only");
        writePublic("notes-1.txt");
        builds.push(await build());
        await deployBoth();
        writeFileSync(join(SITE, "content", "en", "about.json"), `${JSON.stringify({ rev: 2, deleted: true })}\n`);
        writePublic("notes-2.txt");
        builds.push(await build());
        await deployBoth();
        writeEntry("home", 3, "Home, third build");
        writePublic("notes-3.txt");
        builds.push(await build());
        await deployBoth();
        const [b1, b2, b3] = builds as [Manifest, Manifest, Manifest];
        expect(keysOf(b1)).toContain("/about/index.html");
        expect(keysOf(b3)).not.toContain("/about/index.html");
        expect(await (await readKey(HISTORY_INDEX_KEY)).text()).toBe(
          `{"builds":${JSON.stringify([b1.build.id, b2.build.id, b3.build.id].sort())}}\n`,
        );
        expect(readFileSync(join(DIRECTORY, objectKey(HISTORY_INDEX_KEY)), "utf8")).toBe(
          await (await readKey(HISTORY_INDEX_KEY)).text(),
        );

        // b2 went up a month ago, so what it dropped is past its grace; b3's drops are not.
        await backdate(b1.build.id, 40);
        await backdate(b2.build.id, 30);
        const before = await holdings();
        expect(before.presigned).toEqual(before.directory);

        const signed = await signedDeploy(pruning(), ["--out", OUT, "--prune"], [MANIFEST_KEY, HISTORY_INDEX_KEY], 2);
        const [first, second] = signed.dries;
        expect(first?.code).toBe(EXIT_CODES.success);
        expect(first?.stdout).toContain(
          "Prune: deletes nothing — the prune reads 6 keys of the origin's deploy history that PAGEDECK_DEPLOY_URLS holds no GET URL for, so this dry run plans no DELETE",
        );
        expect(second?.stderr).toBe("");
        expect(second?.stdout).not.toContain("Prune: deletes nothing");
        expect(signed.apply?.stderr).toBe("");
        expect(signed.apply?.code).toBe(EXIT_CODES.success);
        const directory = await directoryDeploy(["--apply", "--prune"]);
        expect(directory.stderr).toBe("");
        expect(directory.code).toBe(EXIT_CODES.success);
        runs.push(...signed.dries, signed.apply, directory);

        const gone = pruned(directory);
        expect(gone).toContain("/about/index.html");
        expect(gone).toContain("/notes-1.txt");
        expect(gone).not.toContain("/notes-2.txt");
        expect(pruned(signed.apply)).toEqual(gone);
        expect(signed.deletes.sort()).toEqual([...gone].sort());
        const after = await holdings();
        expect(after.presigned).toEqual(after.directory);
        expect(after.presigned).toEqual(before.presigned.filter((key) => !gone.includes(key)));
        for (const id of builds.map((one) => one.build.id)) {
          expect(after.presigned).toContain(retainedKey(id));
          expect(after.presigned).toContain(deployInstantKey(id));
        }

        const live = readManifest(await (await readKey(MANIFEST_KEY)).text(), MANIFEST_KEY);
        expect(live.build.id).toBe(b3.build.id);
        for (const file of b3.files) {
          const key = fileKey(file.domain, file.path);
          const response = await readKey(key);
          expect(response.status, key).toBe(200);
          expect(Buffer.from(await response.arrayBuffer()).equals(expectedBytes(OUT, file)), key).toBe(true);
        }
        expect(credentialLeaks(origin, runs)).toEqual([]);
        console.log(`[#659] presigned prune deleted ${String(gone.length)} files, the same ${String(gone.length)} the directory prune deleted: ${gone.join(", ")}`);
      }, 600_000);

      test("a prune on an origin with no history index deletes nothing, and names the cause and the fix", async () => {
        const b3 = builds.at(-1) as Manifest;
        // What b3 dropped is now past its grace, so only the missing index holds it back.
        await backdate(b3.build.id, 30);
        const response = await signedFetch({ ...origin, path: objectPath(bucket, objectKey(HISTORY_INDEX_KEY)), method: "DELETE" });
        expect(response.status).toBeLessThan(300);
        expect((await readKey(HISTORY_INDEX_KEY)).status).toBe(404);
        const before = await holdings();
        expect(before.presigned).toContain("/notes-2.txt");

        const run = await signedDeploy(pruning(), ["--out", OUT, "--prune"], [MANIFEST_KEY, HISTORY_INDEX_KEY], 2);
        const cause =
          'the origin holds no history index at "/.pagedeck/deploy-history.json", so this run cannot know which builds the origin served, and does not guess them — apply once with this pagedeck, which writes the index, and prune on a run after that';
        expect(run.dry.stdout).toContain(`Prune: deletes nothing — ${cause}`);
        expect(run.deletes).toEqual([]);
        expect(run.apply?.code).toBe(EXIT_CODES.success);
        expect(run.apply?.stdout.trimEnd().split("\n").at(-1)).toContain(`Pruned nothing: ${cause}`);
        expect((await holdings()).presigned).toEqual([...before.presigned, HISTORY_INDEX_KEY].sort());
        // The apply starts an index from the build it read off the origin and the one it put.
        expect(await (await readKey(HISTORY_INDEX_KEY)).text()).toBe(`{"builds":[${JSON.stringify(b3.build.id)}]}\n`);
        expect(credentialLeaks(origin, [...run.dries, run.apply])).toEqual([]);
      }, 120_000);

      test("an index naming builds beside no manifest is a damaged origin, refused before anything is planned", async () => {
        const live = await (await readKey(MANIFEST_KEY)).text();
        const response = await signedFetch({ ...origin, path: objectPath(bucket, objectKey(MANIFEST_KEY)), method: "DELETE" });
        expect(response.status).toBeLessThan(300);
        const run = await signedDeploy(pruning(), ["--out", OUT, "--prune"], [MANIFEST_KEY, HISTORY_INDEX_KEY]);
        await putKey(MANIFEST_KEY, live);
        expect(run.dry.code).toBe(EXIT_CODES.configError);
        expect(run.dry.stdout).toBe("");
        expect(run.dry.stderr).toContain(
          'Deploy: the origin holds no "/manifest.json", but its history index "/.pagedeck/deploy-history.json" names 1 build, so the origin is damaged rather than new',
        );
        expect(run.apply).toBeUndefined();
        expect(credentialLeaks(origin, [run.dry])).toEqual([]);
      }, 60_000);
    });
  },
);
