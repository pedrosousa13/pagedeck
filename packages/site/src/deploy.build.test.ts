import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  RETENTION_DIR,
  listRetainedManifests,
  readManifest,
  readRetainedManifest,
} from "@pagedeck/core";
import type { Manifest } from "@pagedeck/core";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { netlify } from "@pagedeck/adapter-netlify";
import { planDeploy, planRollback } from "./deploy.js";
import { applyPlan, filesystemTarget } from "./deploy-target.js";
import { runDeploy } from "./deploy-run.js";

const execFileAsync = promisify(execFile);

// Core's `MANIFEST_FILE`, which is internal to `@pagedeck/core`.
const MANIFEST_FILE = "manifest.json";

const SITE = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test");
const OUT = join(SITE, "dist");
const ORIGIN = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test-origin");
const STAGING = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test-staging");
// `pagedeck build` retains the manifest, not the tree, so a rollback's bytes are kept here:
// beside the site, not under a directory `pagedeck build` walks.
const SAVED = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test-tree");

const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const MOVED = "/old-pricing";
const TARGET = "/pricing";
const HEADER = { name: "X-Frame-Options", value: "DENY" };

// Imports nothing, so the fixture needs no `react` resolvable from `packages/site`.
const COUNTER = [
  '"use client";',
  "export default function Counter() {",
  '  return "counter island";',
  "}",
  "",
].join("\n");

const HOME_ONE = "Home, first build";
const HOME_TWO = "Home, second build";
const PRICING = "Pricing, unchanged in both builds";

function writeEntry(path: string, rev: number, title: string): void {
  const file = join(SITE, "content", `${path}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ rev, title })}\n`);
}

// Islanded, so a content-only edit has chunks to leave alone; the island is on the
// page edited between the builds.
function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });
  writeFileSync(
    join(SITE, "components", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );
  writeFileSync(join(SITE, "components", "Counter.js"), COUNTER);
  writeEntry("home", 1, HOME_ONE);
  writeEntry("pricing", 1, PRICING);

  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";

const CONTENT = ${JSON.stringify(join(SITE, "content"))};
const PATHS = ["home", "pricing"];

const read = (path) => JSON.parse(readFileSync(join(CONTENT, path + ".json"), "utf8"));

const upsertAll = (writer) => {
  let cursor = 0;
  for (const path of PATHS) {
    const entry = read(path);
    cursor = Math.max(cursor, entry.rev);
    writer.upsert({ locale: "en", path, data: { title: entry.title } });
  }
  return { changed: PATHS.map((path) => ({ locale: "en", path })), deleted: [], cursor };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: (writer) => upsertAll(writer),
    // Every sync re-reads every entry: the cursor rises when a file is edited,
    // and this fixture is edited between builds on purpose.
    syncSince: (writer) => upsertAll(writer),
    fetchOne: (id) => ({ title: read(id.path).title }),
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    routing: {
      redirects: [
        { from: ${JSON.stringify(MOVED)}, to: ${JSON.stringify(TARGET)}, status: 301 },
      ],
      headers: [
        { prefix: "/", set: [${JSON.stringify(HEADER)}] },
      ],
    },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Prose: "./components/Prose.js",
      Counter: { path: "./components/Counter.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: (page, store) => ({
      tree: [
        {
          component: "Prose",
          props: {
            text: store.getEntry("pages", page.locale, page.entry.path).data.title,
          },
        },
        ...(page.path === "/" ? [{ component: "Counter", props: {} }] : []),
      ],
    }),
  },
});
`,
  );
}

async function run(verb: string): Promise<void> {
  await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
}

async function build(): Promise<Manifest> {
  await run("sync");
  await run("build");
  const file = join(OUT, MANIFEST_FILE);
  return readManifest(readFileSync(file, "utf8"), file);
}

function serve(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const inside = normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    const file = [join(root, inside), join(root, inside, "index.html")].find(
      (one) => existsSync(one) && statSync(one).isFile(),
    );
    if (file === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

async function fetchPage(origin: string, path: string): Promise<string> {
  const response = await fetch(`${origin}${path}`);
  expect(response.status).toBe(200);
  return await response.text();
}

function uploads(plan: { trees: readonly { upload: readonly { key: string }[] }[] }): string[] {
  return plan.trees.flatMap((tree) => tree.upload.map((file) => file.key));
}

let first: Manifest;
let second: Manifest;
let served: { origin: string; close: () => Promise<void> };

beforeAll(async () => {
  rmSync(ORIGIN, { recursive: true, force: true });
  rmSync(STAGING, { recursive: true, force: true });
  rmSync(SAVED, { recursive: true, force: true });
  writeSite();
  first = await build();
  cpSync(OUT, SAVED, { recursive: true });
  served = await serve(ORIGIN);
}, 180_000);

afterAll(async () => {
  if (served !== undefined) await served.close();
  rmSync(SITE, { recursive: true, force: true });
  rmSync(ORIGIN, { recursive: true, force: true });
  rmSync(STAGING, { recursive: true, force: true });
  rmSync(SAVED, { recursive: true, force: true });
  rmSync(DRY_ORIGIN, { recursive: true, force: true });
  rmSync(PUBLISH_ORIGIN, { recursive: true, force: true });
});

test("a first deploy uploads the whole build, assets before HTML, and the local origin serves it", async () => {
  const plan = planDeploy({ to: first });
  expect(plan.from).toBeUndefined();
  expect(plan.stats.unchanged).toBe(0);
  expect(uploads(plan).sort()).toEqual(
    [...first.files].map((file) => file.path).sort(),
  );

  const kinds = plan.trees[0]?.upload.map((file) => file.kind) ?? [];
  expect(kinds).toContain("js");
  expect(kinds.indexOf("html")).toBeGreaterThan(0);
  expect(kinds.slice(0, kinds.indexOf("html"))).not.toContain("html");
  expect(kinds.slice(kinds.indexOf("html")).every((kind) => kind === "html")).toBe(true);

  const started = performance.now();
  const report = await applyPlan(plan, { source: OUT, target: filesystemTarget(ORIGIN) });
  expect(report.uploaded.at(-1)).toBe(`/${MANIFEST_FILE}`);
  expect(existsSync(join(ORIGIN, MANIFEST_FILE))).toBe(true);
  const html = await fetchPage(served.origin, "/");
  const elapsed = performance.now() - started;

  expect(html).toContain(HOME_ONE);
  expect(await fetchPage(served.origin, "/pricing")).toContain(PRICING);
  // Printed, never asserted: a timing assertion on a shared runner flakes.
  console.log(
    `[#57] first deploy published ${String(plan.stats.added)} files (${String(kinds.filter((kind) => kind === "js" || kind === "css").length)} of them JS/CSS) to the local origin in ${elapsed.toFixed(0)} ms`,
  );
}, 60_000);

test("an incremental deploy uploads only the affected files, and no JS or CSS at all", async () => {
  writeEntry("home", 2, HOME_TWO);
  second = await build();

  const plan = planDeploy({ from: first, to: second });

  expect(uploads(plan)).toEqual(["/index.html"]);
  expect(uploads(plan)).not.toContain("/pricing/index.html");
  expect(plan.stats.changed).toBe(1);
  expect(plan.stats.added).toBe(0);
  expect(plan.stats.unchanged).toBe(first.files.length - 1);
  expect(plan.trees[0]?.upload.map((file) => file.kind)).toEqual(["html"]);
  expect(plan.trees[0]?.prune).toEqual([]);
  expect(first.files.some((file) => file.kind === "js")).toBe(true);

  const started = performance.now();
  const report = await applyPlan(plan, { source: OUT, target: filesystemTarget(ORIGIN) });
  const html = await fetchPage(served.origin, "/");
  const elapsed = performance.now() - started;

  expect(report.uploaded).toEqual([
    "/index.html",
    `/${RETENTION_DIR}/${second.build.id}.json`,
    `/${RETENTION_DIR}/${second.build.id}.deployed-at`,
    "/.pagedeck/deploy-history.json",
    `/${MANIFEST_FILE}`,
  ]);
  expect(report.uploaded).not.toContain("/pricing/index.html");
  expect(
    report.uploaded.filter((key) => key.endsWith(".js") || key.endsWith(".css")),
  ).toEqual([]);

  expect(html).toContain(HOME_TWO);
  expect(html).not.toContain(HOME_ONE);
  expect(await fetchPage(served.origin, "/pricing")).toContain(PRICING);
  console.log(
    `[#57] incremental deploy published 1 file to the local origin in ${elapsed.toFixed(0)} ms`,
  );
}, 120_000);

// Run against a copy of the origin taken while build 1 was live: the origin itself
// now holds build 2's manifest, and would plan nothing.
test("a second deploy against a populated origin plans incrementally with no --from", async () => {
  const populated = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test-origin-2");
  rmSync(populated, { recursive: true, force: true });
  cpSync(SAVED, populated, { recursive: true });

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(import.meta.dirname, "..", "dist", "deploy.bin.js"), "--out", "dist", "--origin", populated],
    { cwd: SITE },
  );
  rmSync(populated, { recursive: true, force: true });

  expect(stdout).toContain(`Deploy ${first.build.id} -> ${second.build.id}`);
  expect(stdout).not.toContain("(first deploy)");
  expect(stdout).toContain("1 to upload (0 added, 1 changed");
  expect(stdout).toContain("upload /index.html");
  expect(stdout).not.toContain("upload /pricing/index.html");
  expect(stdout).toContain("DRY RUN");
}, 60_000);

test("a rollback restores the retained build, over HTTP from the local origin", async () => {
  // Out of the store `pagedeck build` wrote, so what is restored is what a rollback finds.
  const retained = await readRetainedManifest(SITE, first.build.id);
  expect(existsSync(join(SITE, RETENTION_DIR))).toBe(true);

  const plan = planRollback({ current: second, retained });
  expect(plan.to.id).toBe(first.build.id);
  expect(uploads(plan)).toEqual(["/index.html"]);

  await applyPlan(plan, {
    source: SAVED,
    target: filesystemTarget(ORIGIN),
  });

  expect(await fetchPage(served.origin, "/")).toContain(HOME_ONE);
  expect(await fetchPage(served.origin, "/pricing")).toContain(PRICING);
}, 60_000);

// Not `STAGING`: a test passing one path as both cannot tell which stayed empty.
const DRY_ORIGIN = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test-dry-origin");

test("the dry run publishes nothing, and says what it would have published", async () => {
  rmSync(DRY_ORIGIN, { recursive: true, force: true });
  const lines: string[] = [];
  const code = await runDeploy(
    { from: first, to: second, source: OUT, origin: DRY_ORIGIN },
    (line) => lines.push(line),
  );

  expect(code).toBe(0);
  expect(existsSync(DRY_ORIGIN)).toBe(false);
  expect(existsSync(STAGING)).toBe(false);
  expect(lines.join("\n")).toContain("DRY RUN");
  expect(lines.join("\n")).toContain("/index.html");
});

test("the compiled netlify artifact carries the declared redirect and header (an artifact, not a live distribution)", () => {
  const output = netlify().compile(second.routing);

  const redirects = output.artifacts.find((one) => one.path === "/_redirects");
  expect(redirects?.role).toBe("tree-file");
  expect(redirects?.contents).toContain(`${MOVED} ${TARGET} 301`);

  const headers = output.artifacts.find((one) => one.path === "/_headers");
  expect(headers?.role).toBe("tree-file");
  expect(headers?.contents).toContain(`${HEADER.name}: ${HEADER.value}`);
});

test("the compiled cloudfront artifacts are staged out of band, never uploaded (an artifact, not a live distribution)", () => {
  const output = cloudfront().compile(second.routing);
  const plan = planDeploy({ from: first, to: second, edge: output });

  expect(plan.edge?.treeFiles).toEqual([]);
  expect(plan.edge?.outOfBand.map((one) => one.role)).toContain("function");
  expect(uploads(plan)).toEqual(["/index.html"]);

  const viewer = plan.edge?.outOfBand.find((one) => one.slot === "viewer-request");
  expect(viewer?.contents).toContain(MOVED);
  expect(viewer?.contents).toContain(TARGET);
});

test("the compiled worker is staged out of band, never uploaded to the bucket it serves", () => {
  const output = cloudflareWorker().compile(second.routing);
  const plan = planDeploy({ from: first, to: second, edge: output });

  expect(plan.edge?.treeFiles).toEqual([]);
  expect(plan.edge?.outOfBand.map((one) => `${one.role} ${one.path} ${String(one.binding)}`)).toEqual([
    "edge-module worker.js PAGEDECK_ORIGIN",
  ]);
  expect(uploads(plan)).toEqual(["/index.html"]);

  const worker = plan.edge?.outOfBand[0];
  expect(worker?.contents).toContain(`[${JSON.stringify(MOVED)}, { to: ${JSON.stringify(TARGET)}, status: 301 }]`);
});

test("the runnable stages the out-of-band edge artifacts it was asked to compile, and writes none of them", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(import.meta.dirname, "..", "dist", "deploy.bin.js"),
      "--out",
      "dist",
      "--origin",
      ORIGIN,
      "--staging",
      STAGING,
      "--edge",
      "cloudfront-function",
    ],
    { cwd: SITE },
  );

  expect(stdout).toContain("edge artifacts, compiled for cloudfront-function");
  expect(stdout).toContain("applied out of band by CI");
  expect(stdout).toContain("DRY RUN");
  expect(stdout).not.toContain("upload /_redirects");
  expect(existsSync(STAGING)).toBe(false);
}, 60_000);

const PUBLISH_ORIGIN = join(import.meta.dirname, "..", ".pagedeck-deploy-build-test-publish-origin");

test("an applying run files the build it deployed into the origin's history, and only that build", async () => {
  rmSync(PUBLISH_ORIGIN, { recursive: true, force: true });
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(import.meta.dirname, "..", "dist", "deploy.bin.js"),
      "--out",
      "dist",
      "--origin",
      PUBLISH_ORIGIN,
      "--apply",
      "--prune",
    ],
    { cwd: SITE },
  );

  expect(stdout).toContain(
    `Filed this build into the origin's deploy history at /${RETENTION_DIR}/${second.build.id}.json`,
  );
  // Through `@pagedeck/core`'s reader, not a directory walk: the next prune opens it as a store.
  const published = await listRetainedManifests(PUBLISH_ORIGIN);
  // `first` was built on this runner but never served here, so it must not be in the
  // history (#287).
  expect(published.map((one) => one.build.id)).toEqual([second.build.id]);
  expect(existsSync(join(PUBLISH_ORIGIN, RETENTION_DIR, `${first.build.id}.json`))).toBe(
    false,
  );
  const at = join(PUBLISH_ORIGIN, MANIFEST_FILE);
  expect(readManifest(readFileSync(at, "utf8"), at).build.id).toBe(second.build.id);
  expect(stdout).toContain("Pruned nothing");
  const instant = readFileSync(
    join(PUBLISH_ORIGIN, RETENTION_DIR, `${second.build.id}.deployed-at`),
    "utf8",
  );
  expect(instant).toBe(`${new Date(instant.trim()).toISOString()}\n`);
  expect(stdout).toContain(
    `Recorded when it was deployed at /${RETENTION_DIR}/${second.build.id}.deployed-at`,
  );
  // The directory's listing is the history, so its index names what the listing held
  // and the build deployed (#659).
  expect(stdout).toContain("Named it in the origin's history index at /.pagedeck/deploy-history.json");
  expect(readFileSync(join(PUBLISH_ORIGIN, ".pagedeck", "deploy-history.json"), "utf8")).toBe(
    `{"builds":[${JSON.stringify(second.build.id)}]}\n`,
  );
}, 60_000);

test("the runnable reports a deploy instant at the origin it cannot read, and still plans", async () => {
  const file = join(PUBLISH_ORIGIN, RETENTION_DIR, `${second.build.id}.deployed-at`);
  const dryRun = async (): Promise<string> =>
    (
      await execFileAsync(
        process.execPath,
        [
          join(import.meta.dirname, "..", "dist", "deploy.bin.js"),
          "--out",
          "dist",
          "--origin",
          PUBLISH_ORIGIN,
        ],
        { cwd: SITE },
      )
    ).stdout;

  writeFileSync(file, "last Tuesday\n");
  const garbled = await dryRun();
  expect(garbled).toContain("Deploy history: 1 deploy instant at the origin could not be read");
  expect(garbled).toContain(
    `  "/${RETENTION_DIR}/${second.build.id}.deployed-at": it holds no ISO-8601 instant`,
  );
  expect(garbled).toContain("DRY RUN");
  expect(readFileSync(file, "utf8")).toBe("last Tuesday\n");

  rmSync(file);
  mkdirSync(file);
  const unopenable = await dryRun();
  expect(unopenable).toContain(
    `  "/${RETENTION_DIR}/${second.build.id}.deployed-at": it could not be opened (EISDIR: illegal operation on a directory)`,
  );
  rmSync(file, { recursive: true });
}, 60_000);
