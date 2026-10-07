import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  buildManifest,
  ConfigError,
  listRetainedManifests,
  planEntries,
  planRouting,
  planTiers,
  RETENTION_DIR,
  retainManifest,
} from "@pagedeck/core";
import type { EmittedFile, Manifest, Page } from "@pagedeck/core";
import { isReservedDeployKey } from "@pagedeck/core/routing";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import type { EdgeOutput } from "@pagedeck/edge";
import {
  describePlan,
  planDeploy,
  planRetainedPrune,
  planRollback,
} from "./deploy.js";
import {
  applyPlan,
  filesystemTarget,
  MANIFEST_KEY,
  presignedTarget,
  prunePlan,
  deployInstantKey,
  BUILD_ID_MAX_BYTES,
  HISTORY_INDEX_KEY,
  HISTORY_INDEX_MAX_BUILDS,
  readDeployInstant,
  readHistoryIndex,
  retainedKey,
} from "./deploy-target.js";
import type { DeployTarget } from "./deploy-target.js";
import { documentMetadata, fileMetadata } from "./deploy-metadata.js";
import type { ObjectMetadata } from "./deploy-metadata.js";
import { APPLY_FLAG, FORCE_FLAG, PRUNE_FLAG, runDeploy, runRollback } from "./deploy-run.js";

const ADAPTERS = { "cloudfront-function": cloudfront(), "cloudflare-worker": cloudflareWorker() };

const HOME: Page = { locale: "en", path: "/", output: "/", dependencies: [] };

function manifestOf(
  id: string,
  createdAt: string,
  outputs: readonly EmittedFile[],
  parent?: string,
): Manifest {
  const entries = planEntries([{ page: HOME, islands: [] }], { modules: {} });
  return buildManifest({
    build: { id, createdAt, ...(parent === undefined ? {} : { parent }) },
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

const HOME_HTML = "<!doctype html><title>Home</title>";
const STYLE = "a{color:red}";

const BEFORE = manifestOf("build-01", "2026-08-25T10:00:00.000Z", [
  { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: HOME_HTML },
  { path: "/assets/app-a1b2c3.js", kind: "js", contents: "console.log(1);" },
  { path: "/assets/site-9f8e7d.css", kind: "css", contents: STYLE },
]);

const AFTER = manifestOf(
  "build-02",
  "2026-08-26T09:30:00.000Z",
  [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Home, revised</title>",
    },
    { path: "/assets/app-d4e5f6.js", kind: "js", contents: "console.log(2);" },
    { path: "/assets/site-9f8e7d.css", kind: "css", contents: STYLE },
  ],
  "build-01",
);

function uploads(plan: { trees: readonly { upload: readonly { key: string }[] }[] }): string[] {
  return plan.trees.flatMap((tree) => tree.upload.map((file) => file.key));
}

const scratches: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-deploy-"));
  scratches.push(dir);
  return dir;
}

function writeTree(
  root: string,
  files: readonly { path: string; contents: string }[],
  manifest?: Manifest,
): string {
  for (const file of files) {
    const at = join(root, file.path);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, file.contents);
  }
  if (manifest !== undefined) writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return root;
}

function walk(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")}`)
    .sort();
}

// Pinned character for character: a regex matching a substring would still pass
// after half a message was deleted.
async function refusal(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("expected the call to refuse, and it did not");
}

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("an incremental deploy plans only the files that changed", () => {
  const plan = planDeploy({ from: BEFORE, to: AFTER });

  expect(uploads(plan)).toEqual(["/assets/app-d4e5f6.js", "/index.html"]);
  expect(uploads(plan)).not.toContain("/assets/site-9f8e7d.css");
  expect(plan.stats.unchanged).toBe(1);
  expect(plan.trees[0]?.upload.map((file) => file.kind)).toEqual(["js", "html"]);
  expect(plan.trees[0]?.prune.map((file) => file.key)).toEqual(["/assets/app-a1b2c3.js"]);
});

test("a first deploy, with no previous manifest, uploads everything", () => {
  const plan = planDeploy({ to: AFTER });

  expect(plan.from).toBeUndefined();
  expect(uploads(plan)).toEqual([
    "/assets/app-d4e5f6.js",
    "/assets/site-9f8e7d.css",
    "/index.html",
  ]);
  expect(plan.stats.unchanged).toBe(0);
  expect(plan.stats.changed).toBe(0);
  expect(plan.stats.added).toBe(3);
  expect(plan.trees[0]?.prune).toEqual([]);
});

test("a rollback plan restores the retained build", () => {
  const plan = planRollback({ current: AFTER, retained: BEFORE });

  expect(plan.to.id).toBe("build-01");
  expect(plan.from?.id).toBe("build-02");
  expect(uploads(plan)).toEqual(["/assets/app-a1b2c3.js", "/index.html"]);
  expect(plan.trees[0]?.prune.map((file) => file.key)).toEqual(["/assets/app-d4e5f6.js"]);
});

test("edge artifacts split into the uploaded tree and the group CI applies", () => {
  const edge: EdgeOutput = {
    target: "netlify",
    artifacts: [
      { role: "tree-file", path: "/_redirects", contents: "/old /new 301\n" },
      { role: "tree-file", path: "/_headers", contents: "/*\n  X-Frame-Options: DENY\n" },
      { role: "server-config", path: "netlify.toml", contents: "[build]\n" },
    ],
  };
  const plan = planDeploy({ from: BEFORE, to: AFTER, edge });

  expect(plan.edge?.treeFiles.map((one) => one.path)).toEqual(["/_redirects", "/_headers"]);
  expect(plan.edge?.outOfBand.map((one) => one.path)).toEqual(["netlify.toml"]);
  expect(uploads(plan)).not.toContain("/_redirects");
  expect(uploads(plan)).not.toContain("netlify.toml");
});

test("the filesystem target applied to a plan produces the expected tree", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
      { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    AFTER,
  );
  const origin = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/assets/app-a1b2c3.js", contents: "console.log(1);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    BEFORE,
  );
  const staging = scratch();

  const edge: EdgeOutput = {
    target: "netlify",
    artifacts: [
      { role: "tree-file", path: "/_redirects", contents: "/old /new 301\n" },
      { role: "server-config", path: "netlify.toml", contents: "[build]\n" },
    ],
  };
  const plan = planDeploy({ from: BEFORE, to: AFTER, edge });
  const report = await applyPlan(plan, {
    source,
    target: filesystemTarget(origin),
    staging,
  });

  expect(report.uploaded).toEqual([
    "/assets/app-d4e5f6.js",
    "/index.html",
    "/_redirects",
    retainedKey("build-02"),
    deployInstantKey("build-02"),
    HISTORY_INDEX_KEY,
    "/manifest.json",
  ]);
  expect(walk(origin)).toEqual([
    HISTORY_INDEX_KEY,
    `/${RETENTION_DIR}/build-02.deployed-at`,
    `/${RETENTION_DIR}/build-02.json`,
    "/_redirects",
    "/assets/app-a1b2c3.js",
    "/assets/app-d4e5f6.js",
    "/assets/site-9f8e7d.css",
    "/index.html",
    "/manifest.json",
  ]);
  expect(
    (JSON.parse(readFileSync(join(origin, "manifest.json"), "utf8")) as Manifest).build.id,
  ).toBe("build-02");
  expect(readFileSync(join(origin, "index.html"), "utf8")).toBe(
    "<!doctype html><title>Home, revised</title>",
  );
  expect(report.staged).toEqual(["netlify.toml"]);
  expect(walk(staging)).toEqual(["/netlify.toml"]);
});

const SHOP: Page = {
  locale: "shop",
  path: "/",
  domain: "shop.example",
  declaredDomain: "shop.example",
  output: "/",
  dependencies: [],
};

function treesManifest(
  pages: readonly Page[],
  outputs: readonly EmittedFile[] = pages.map((page) => ({
    ...(page.domain === undefined ? {} : { domain: page.domain }),
    path: "/index.html",
    kind: "html",
    page: { locale: page.locale, path: page.path },
    contents: HOME_HTML,
  })),
): Manifest {
  const entries = planEntries(
    pages.map((page) => ({ page, islands: [] })),
    { modules: {} },
  );
  return buildManifest({
    build: { id: "build-01", createdAt: "2026-08-25T10:00:00.000Z" },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages, trailingSlash: "never" }),
    pages,
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs,
  });
}

// A re-deploy of the live build, so the plan uploads nothing and only the staging runs.
async function stage(manifest: Manifest, target: keyof typeof ADAPTERS): Promise<string> {
  const staging = scratch();
  const edge = ADAPTERS[target].compile(manifest.routing);
  await applyPlan(planDeploy({ from: manifest, to: manifest, edge }), {
    source: writeTree(scratch(), [], manifest),
    target: filesystemTarget(scratch()),
    staging,
  });
  return staging;
}

test.each([
  ["cloudfront-function", ["/routing.request.js", "/shop.example/routing.request.js"]],
  ["cloudflare-worker", ["/shop.example/worker.js", "/worker.js"]],
] as const)(
  "a site with two trees stages each domain tree's %s artifacts under its tree key (#669)",
  async (target, staged) => {
    const manifest = treesManifest([HOME, SHOP]);
    const staging = await stage(manifest, target);

    expect(walk(staging)).toEqual(staged);
    for (const one of ADAPTERS[target].compile(manifest.routing).artifacts) {
      const at = join(staging, one.domain ?? "", one.path);
      expect(readFileSync(at, "utf8"), at).toBe(one.contents);
    }
    expect(readFileSync(join(staging, staged[1] as string), "utf8")).not.toBe(
      readFileSync(join(staging, staged[0] as string), "utf8"),
    );
  },
);

test("a site whose one tree is a domain tree stages under its tree key, as each domain tree does (#669)", async () => {
  const staging = await stage(treesManifest([SHOP]), "cloudflare-worker");

  expect(walk(staging)).toEqual(["/shop.example/worker.js"]);
});

test("the plan names the domain tree each staged artifact belongs to (#669)", () => {
  const manifest = treesManifest([HOME, SHOP]);
  const plan = planDeploy({
    to: manifest,
    edge: ADAPTERS["cloudflare-worker"].compile(manifest.routing),
  });

  expect(describePlan(plan).filter((line) => line.includes("stage"))).toEqual([
    "    stage  worker.js (edge-module) — applied out of band by CI",
    "    stage  shop.example/worker.js (edge-module, tree shop.example) — applied out of band by CI",
  ]);
});

test("an applying run reports each staged artifact with the tree it belongs to (#669)", async () => {
  const manifest = treesManifest([HOME, SHOP]);
  const lines: string[] = [];
  await runDeploy(
    {
      from: manifest,
      to: manifest,
      edge: ADAPTERS["cloudflare-worker"].compile(manifest.routing),
      source: writeTree(scratch(), [], manifest),
      origin: scratch(),
      staging: scratch(),
      apply: true,
    },
    (line) => lines.push(line),
  );

  const at = lines.indexOf("Staged 2 out-of-band edge artifacts for CI to apply.");
  expect(lines.slice(at, at + 3)).toEqual([
    "Staged 2 out-of-band edge artifacts for CI to apply.",
    "    staged worker.js (tree (default))",
    "    staged shop.example/worker.js (tree shop.example)",
  ]);
});

const SHOP_HTML = "<!doctype html><title>Shop</title>";
const SHOP_ONLY = "console.log('shop');";

const TWO_TREES = treesManifest(
  [HOME, SHOP],
  [
    { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: HOME_HTML },
    {
      domain: "shop.example",
      path: "/index.html",
      kind: "html",
      page: { locale: "shop", path: "/" },
      contents: SHOP_HTML,
    },
    { domain: "shop.example", path: "/assets/shop-only.js", kind: "js", contents: SHOP_ONLY },
  ],
);

test("a deploy uploads each tree's files from that tree's directory in the source (#676)", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/shop.example/index.html", contents: SHOP_HTML },
      { path: "/shop.example/assets/shop-only.js", contents: SHOP_ONLY },
    ],
    TWO_TREES,
  );
  const origin = scratch();

  const report = await applyPlan(planDeploy({ to: TWO_TREES }), {
    source,
    target: filesystemTarget(origin),
  });

  expect(uploads(planDeploy({ to: TWO_TREES }))).toEqual([
    "/index.html",
    "//shop.example/assets/shop-only.js",
    "//shop.example/index.html",
  ]);
  expect(report.uploaded.slice(0, 3)).toEqual(uploads(planDeploy({ to: TWO_TREES })));
  expect(readFileSync(join(origin, "index.html"), "utf8")).toBe(HOME_HTML);
  expect(readFileSync(join(origin, "shop.example", "index.html"), "utf8")).toBe(SHOP_HTML);
  expect(readFileSync(join(origin, "shop.example", "assets", "shop-only.js"), "utf8")).toBe(
    SHOP_ONLY,
  );
});

test("a domain tree's file missing from the source is refused with its tree named (#676)", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/shop.example/index.html", contents: SHOP_HTML },
      { path: "/assets/shop-only.js", contents: SHOP_ONLY },
    ],
    TWO_TREES,
  );

  const error = await refusal(
    applyPlan(planDeploy({ to: TWO_TREES }), { source, target: filesystemTarget(scratch()) }),
  );

  expect(error.message).toBe(
    `Deploy of "/assets/shop-only.js" in the "shop.example" tree: ${JSON.stringify(join(source, "shop.example"))} does not hold this file, and a domain tree's rows are read from its tree key's directory in the source tree at ${JSON.stringify(source)} — point the source at the tree the build being deployed wrote`,
  );
});

test("a staged path that resolves outside the staging directory is refused before anything is uploaded (#669)", async () => {
  const root = scratch();
  const staging = join(root, "a", "b");
  const origin = scratch();
  const edge: EdgeOutput = {
    target: "cloudflare-worker",
    artifacts: [
      { domain: "../../x", role: "edge-module", path: "worker.js", contents: "escaped" },
      { role: "edge-module", path: "worker.js", contents: "kept" },
      { domain: "..", role: "edge-module", path: "..", contents: "escaped" },
    ],
  };

  const error = await refusal(
    applyPlan(planDeploy({ from: AFTER, to: AFTER, edge }), {
      source: writeTree(scratch(), [], AFTER),
      target: filesystemTarget(origin),
      staging,
    }),
  );

  expect(error).toEqual(
    new ConfigError(
      [
        `Deploy: 2 out-of-band edge artifacts would be staged outside the staging directory ${JSON.stringify(staging)}, so nothing was uploaded or staged — each path comes from a routing tree's domain in the manifest, which pagedeck build never writes this way; build again and deploy the manifest that build writes:`,
        '  "../../x/worker.js"',
        '  "../.."',
      ].join("\n"),
    ),
  );
  expect(walk(root)).toEqual([]);
  expect(walk(origin)).toEqual([]);
});

test("every key the deploy writes for itself is one the edge keeps off (#556)", () => {
  // The edge denies keys from `isReservedDeployKey`, and the deploy spells its own:
  // they meet only here.
  for (const key of [MANIFEST_KEY, retainedKey("build-02"), deployInstantKey("build-02")]) {
    expect(isReservedDeployKey(key), key).toBe(true);
  }
});

test("a prune deletes nothing before the grace period is out, and the stale file after", async () => {
  const origin = writeTree(scratch(), [
    { path: "/index.html", contents: HOME_HTML },
    { path: "/assets/app-a1b2c3.js", contents: "console.log(1);" },
  ]);
  const plan = planDeploy({ from: BEFORE, to: AFTER });
  const target = filesystemTarget(origin);

  expect(await prunePlan(plan, { target, now: new Date(AFTER.build.createdAt) })).toEqual([]);
  expect(walk(origin)).toContain("/assets/app-a1b2c3.js");

  const after = new Date(Date.parse(plan.prune.notBefore) + 1000);
  expect(await prunePlan(plan, { target, now: after })).toEqual(["/assets/app-a1b2c3.js"]);
  expect(walk(origin)).toEqual(["/index.html"]);
});

const WITH_PAGE = manifestOf(
  "build-03",
  "2026-08-27T09:30:00.000Z",
  [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Home, revised</title>",
    },
    { path: "/assets/app-d4e5f6.js", kind: "js", contents: "console.log(2);" },
    { path: "/assets/site-9f8e7d.css", kind: "css", contents: STYLE },
    {
      path: "/retracted/index.html",
      kind: "html",
      page: { locale: "en", path: "/retracted" },
      contents: "<!doctype html><title>Retracted</title>",
    },
  ],
  "build-01",
);

test("a prune deletes a dropped page at once, and a dropped chunk only after the grace period (#555)", async () => {
  const origin = writeTree(scratch(), [
    { path: "/index.html", contents: HOME_HTML },
    { path: "/retracted/index.html", contents: "<!doctype html><title>Retracted</title>" },
    { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
  ]);
  const plan = planDeploy({ from: WITH_PAGE, to: BEFORE, prune: { graceSeconds: 604800 } });
  const target = filesystemTarget(origin);

  expect(await prunePlan(plan, { target, now: new Date(BEFORE.build.createdAt) })).toEqual([
    "/retracted/index.html",
  ]);
  expect(walk(origin)).toEqual(["/assets/app-d4e5f6.js", "/index.html"]);

  const after = new Date(Date.parse(plan.prune.notBefore) + 1000);
  expect(await prunePlan(plan, { target, now: after })).toEqual([
    "/assets/app-d4e5f6.js",
    "/retracted/index.html",
  ]);
  expect(walk(origin)).toEqual(["/index.html"]);
});

test("a rollback with prune takes down a page the rolled-back build added, and holds its chunk (#555)", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/assets/app-a1b2c3.js", contents: "console.log(1);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    BEFORE,
  );
  const origin = writeTree(scratch(), [
    { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
    { path: "/retracted/index.html", contents: "<!doctype html><title>Retracted</title>" },
    { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
    { path: "/assets/site-9f8e7d.css", contents: STYLE },
  ]);
  const now = new Date("2026-08-27T10:00:00.000Z");
  const lines: string[] = [];

  await runRollback(
    {
      current: WITH_PAGE,
      retained: BEFORE,
      source,
      origin,
      apply: true,
      pruneAfterUpload: true,
      now,
    },
    (line) => lines.push(line),
  );

  expect(walk(origin)).not.toContain("/retracted/index.html");
  expect(walk(origin)).toContain("/assets/app-d4e5f6.js");
  expect(lines).toContain(`Pruned 1 file from ${filesystemTarget(origin).name}.`);
  expect(lines).toContain("    prune  /retracted/index.html");
  expect(lines).toContain(
    "Held 1 file: the grace period on it is out no earlier than 2026-09-01T10:00:00.000Z.",
  );
});

test("an apply without prune says the pages go on the next prune and the rest after the grace period (#555)", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/assets/app-a1b2c3.js", contents: "console.log(1);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    BEFORE,
  );
  const origin = scratch();
  const lines: string[] = [];
  const plan = planDeploy({ from: WITH_PAGE, to: BEFORE });

  await runRollback(
    { current: WITH_PAGE, retained: BEFORE, source, origin, apply: true, now: new Date() },
    (line) => lines.push(line),
  );

  expect(lines).toContain(
    `Prune 1 page on the next ${PRUNE_FLAG} run, and 1 file no earlier than ${plan.prune.notBefore}.`,
  );
  expect(walk(origin)).toContain("/index.html");
});

test("the dry run writes nothing and prints the plan", async () => {
  const origin = scratch();
  const source = scratch();
  const lines: string[] = [];
  const code = await runDeploy(
    { from: BEFORE, to: AFTER, source, origin },
    (line) => lines.push(line),
  );

  expect(code).toBe(0);
  expect(walk(origin)).toEqual([]);
  expect(lines.join("\n")).toContain("DRY RUN");
  expect(lines.join("\n")).toContain("/assets/app-d4e5f6.js");
  expect(lines.join("\n")).toContain("/index.html");
  expect(lines.join("\n")).toContain(APPLY_FLAG);
});

test("the plan describes itself with counts, bytes and both edge groups", () => {
  const edge: EdgeOutput = {
    target: "netlify",
    artifacts: [
      { role: "tree-file", path: "/_redirects", contents: "/old /new 301\n" },
      { role: "server-config", path: "netlify.toml", contents: "[build]\n" },
    ],
  };
  const text = describePlan(planDeploy({ from: BEFORE, to: AFTER, edge })).join("\n");

  expect(text).toContain("3 to upload");
  expect(text).toContain("1 to prune");
  expect(text).toContain("1 unchanged");
  expect(text).toContain("netlify.toml");
});

const RACED = manifestOf(
  "build-03",
  "2026-08-27T09:30:00.000Z",
  [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Home, raced</title>",
    },
    { path: "/assets/app-d4e5f6.js", kind: "js", contents: "console.log(2);" },
    { path: "/assets/site-9f8e7d.css", kind: "css", contents: STYLE },
  ],
  "build-99",
);

test("the plan carries the raced-deploy report, and a chained deploy carries none", () => {
  expect(planDeploy({ from: BEFORE, to: AFTER }).raced).toBeUndefined();

  const raced = planDeploy({ from: BEFORE, to: RACED }).raced;
  expect(raced).toBe(
    'Manifest diff: build "build-03" was built on "build-99" and is being deployed over build "build-01", so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy',
  );
  expect(describePlan(planDeploy({ from: BEFORE, to: RACED })).join("\n")).toContain(
    "RACED:",
  );
  expect(planDeploy({ to: RACED }).raced).toBeUndefined();
  expect(planRollback({ current: AFTER, retained: BEFORE }).raced).toBeUndefined();
});

test("a raced deploy refuses to apply, and --force is the one way past it", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: "<!doctype html><title>Home, raced</title>" },
      { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    RACED,
  );
  const origin = scratch();
  const lines: string[] = [];

  await expect(
    runDeploy(
      { from: BEFORE, to: RACED, source, origin, apply: true },
      (line) => lines.push(line),
    ),
  ).rejects.toThrow(ConfigError);
  expect(walk(origin)).toEqual([]);

  const error = await refusal(
    runDeploy({ from: BEFORE, to: RACED, source, origin, apply: true }, () => {}),
  );
  expect(error.message).toBe(
    `Manifest diff: build "build-03" was built on "build-99" and is being deployed over build "build-01", so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy — this run refused to upload; pass ${FORCE_FLAG} beside ${APPLY_FLAG} to deploy it anyway`,
  );

  const code = await runDeploy(
    { from: BEFORE, to: RACED, source, origin, apply: true, force: true },
    () => {},
  );
  expect(code).toBe(0);
  expect(walk(origin)).toEqual([
    HISTORY_INDEX_KEY,
    `/${RETENTION_DIR}/build-03.deployed-at`,
    `/${RETENTION_DIR}/build-03.json`,
    "/assets/app-d4e5f6.js",
    "/index.html",
    "/manifest.json",
  ]);

  const dry = scratch();
  expect(
    await runDeploy({ from: BEFORE, to: RACED, source, origin: dry }, () => {}),
  ).toBe(0);
  expect(walk(dry)).toEqual([]);
});

test("the run prunes only when asked, and only once the grace period is out", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
      { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    AFTER,
  );
  const plan = planDeploy({ from: BEFORE, to: AFTER });
  const stale = "/assets/app-a1b2c3.js";

  const early = writeTree(scratch(), [{ path: stale, contents: "console.log(1);" }]);
  const inside: string[] = [];
  await runDeploy(
    {
      from: BEFORE,
      to: AFTER,
      source,
      origin: early,
      apply: true,
      pruneAfterUpload: true,
      now: new Date(AFTER.build.createdAt),
    },
    (line) => inside.push(line),
  );
  expect(walk(early)).toContain(stale);
  expect(inside.join("\n")).toContain("Pruned nothing");

  const late = writeTree(scratch(), [{ path: stale, contents: "console.log(1);" }]);
  const after: string[] = [];
  await runDeploy(
    {
      from: BEFORE,
      to: AFTER,
      source,
      origin: late,
      apply: true,
      pruneAfterUpload: true,
      now: new Date(Date.parse(plan.prune.notBefore) + 1000),
    },
    (line) => after.push(line),
  );
  expect(walk(late)).not.toContain(stale);
  expect(after.join("\n")).toContain("Pruned 1 file from");
  expect(after.join("\n")).toContain(stale);

  const kept = writeTree(scratch(), [{ path: stale, contents: "console.log(1);" }]);
  const quiet: string[] = [];
  await runDeploy(
    {
      from: BEFORE,
      to: AFTER,
      source,
      origin: kept,
      apply: true,
      now: new Date(Date.parse(plan.prune.notBefore) + 1000),
    },
    (line) => quiet.push(line),
  );
  expect(walk(kept)).toContain(stale);
  expect(quiet.join("\n")).toContain("no earlier than");
  expect(PRUNE_FLAG).toBe("--prune");
});

test("the presigned target refuses a scheme a deploy may not send bytes over", async () => {
  const target = presignedTarget({
    put: () => "http://origin.example/site/index.html?sig=SECRET",
    delete: () => "http://origin.example/site/index.html?sig=SECRET",
  });

  const put = await refusal(target.put("/index.html", new Uint8Array([1]), documentMetadata("/index.html")));
  expect(put.message).toBe(
    'Deploy of "/index.html": the presigned URL is a http: URL, and a deploy sends bytes only over https — presign it over https, the scheme pagedeck store push already requires',
  );
  expect(put.message).not.toContain("SECRET");

  const removed = await refusal(target.delete("/assets/app-a1b2c3.js"));
  expect(removed.message).toBe(
    'Deploy of "/assets/app-a1b2c3.js": the presigned URL is a http: URL, and a deploy sends bytes only over https — presign it over https, the scheme pagedeck store push already requires',
  );
});

test("the presigned target reports the status a host answered, and never the URL", async () => {
  const requested: { method: string; redirect: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requested.push({ method: init?.method ?? "GET", redirect: init?.redirect ?? "follow" });
    return new Response("denied", { status: 403 });
  }) as typeof fetch;
  try {
    const target = presignedTarget({
      put: () => "https://origin.example/site/index.html?sig=SECRET",
      delete: () => "https://origin.example/site/index.html?sig=SECRET",
    });

    const put = await refusal(target.put("/index.html", new Uint8Array([1]), documentMetadata("/index.html")));
    expect(put.message).toBe(
      'Deploy of "/index.html": the host answered 403 to PUT — re-presign the URL, and check that the credential it was signed with may write this key. The URL is not printed: it carries the credential in its query string.',
    );
    expect(put.message).not.toContain("SECRET");
    expect(put.message).not.toContain("origin.example");

    const removed = await refusal(target.delete("/index.html"));
    expect(removed.message).toContain("403 to DELETE");
  } finally {
    globalThis.fetch = real;
  }

  expect(requested).toEqual([
    { method: "PUT", redirect: "manual" },
    { method: "DELETE", redirect: "manual" },
  ]);
  expect(
    presignedTarget({ put: () => "https://x/", delete: () => "https://x/" }).name,
  ).toBe("presigned https target");
});

test("the presigned target sends each object's type and cache policy as headers, and hands them to the signer (#560)", async () => {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const signed: { key: string; metadata: ObjectMetadata }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const target = presignedTarget({
      put: (key, metadata) => {
        signed.push({ key, metadata });
        return `https://origin.example${key}?sig=1`;
      },
      delete: (key) => `https://origin.example${key}?sig=1`,
    });
    const page = fileMetadata({ path: "/index.html", kind: "html" });
    const chunk = fileMetadata({ path: "/assets/app-C52oINTW.js", kind: "js", hashed: true });
    const manifest = documentMetadata(MANIFEST_KEY);
    await target.put("/index.html", new Uint8Array([1]), page);
    await target.put("/assets/app-C52oINTW.js", new Uint8Array([1]), chunk);
    await target.put(MANIFEST_KEY, new Uint8Array([1]), manifest);
    await target.delete("/index.html");
    expect(signed).toEqual([
      { key: "/index.html", metadata: page },
      { key: "/assets/app-C52oINTW.js", metadata: chunk },
      { key: MANIFEST_KEY, metadata: manifest },
    ]);
  } finally {
    globalThis.fetch = real;
  }
  expect(sent).toEqual([
    {
      url: "https://origin.example/index.html?sig=1",
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    },
    {
      url: "https://origin.example/assets/app-C52oINTW.js?sig=1",
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    },
    {
      url: "https://origin.example/manifest.json?sig=1",
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
    },
    { url: "https://origin.example/index.html?sig=1", headers: {} },
  ]);
});

const LATER = manifestOf(
  "build-10",
  "2026-09-05T09:30:00.000Z",
  [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Home, later</title>",
    },
    { path: "/assets/app-778899.js", kind: "js", contents: "console.log(3);" },
    { path: "/assets/site-9f8e7d.css", kind: "css", contents: STYLE },
  ],
  "build-02",
);

test("the retained prune deletes what an older build left behind, and waits on the rest", () => {
  const prune = planRetainedPrune({
    live: LATER,
    retained: [BEFORE, AFTER, LATER],
    now: new Date(LATER.build.createdAt),
  });

  // build-01's chunk stopped being served when build-02 went up, ten days ago: the
  // deadline belongs to the superseding build, not to the one running the prune.
  expect(prune.due).toEqual([
    {
      key: "/assets/app-a1b2c3.js",
      droppedBy: "build-02",
      notBefore: "2026-09-02T09:30:00.000Z",
    },
  ]);
  expect(prune.waiting).toEqual([
    {
      key: "/assets/app-d4e5f6.js",
      droppedBy: "build-10",
      notBefore: "2026-09-12T09:30:00.000Z",
    },
  ]);
  expect([...prune.due, ...prune.waiting].map((one) => one.key)).not.toContain(
    "/index.html",
  );
  expect([...prune.due, ...prune.waiting].map((one) => one.key)).not.toContain(
    "/assets/site-9f8e7d.css",
  );
});

test("a retained manifest stamped after the live build cannot make the live site prunable", () => {
  // Stamped ahead of the live build, so by age alone every key the live build holds
  // and it does not would read as superseded.
  const skewed = manifestOf("build-99", "2027-01-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Never deployed</title>",
    },
  ]);
  const prune = planRetainedPrune({
    live: LATER,
    retained: [BEFORE, AFTER, LATER, skewed],
    now: new Date("2027-06-01T00:00:00.000Z"),
  });

  expect(prune.due.map((one) => one.key)).toEqual([
    "/assets/app-a1b2c3.js",
    "/assets/app-d4e5f6.js",
  ]);
  expect(prune.waiting).toEqual([]);
});

test("an apply files the build it deployed into the origin's history, and the manifest still goes last", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
      { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    AFTER,
  );
  const origin = scratch();

  const report = await applyPlan(planDeploy({ from: BEFORE, to: AFTER }), {
    source,
    target: filesystemTarget(origin),
  });

  expect(report.retained).toBe(retainedKey("build-02"));
  expect(report.uploaded.at(-1)).toBe(MANIFEST_KEY);
  expect(report.uploaded).toEqual([
    "/assets/app-d4e5f6.js",
    "/index.html",
    retainedKey("build-02"),
    deployInstantKey("build-02"),
    HISTORY_INDEX_KEY,
    MANIFEST_KEY,
  ]);
  expect(walk(origin)).toContain(`/${RETENTION_DIR}/build-02.json`);
  expect((await listRetainedManifests(origin)).map((one) => one.build.id)).toEqual([
    "build-02",
  ]);
  expect(readFileSync(join(origin, RETENTION_DIR, "build-02.json"), "utf8")).toBe(
    readFileSync(join(origin, "manifest.json"), "utf8"),
  );
});

test("three deploys on fresh runners: the third prunes what the first left behind", async () => {
  const origin = scratch();
  const stale = "/assets/app-a1b2c3.js";
  const sources = {
    BEFORE: writeTree(
      scratch(),
      [
        { path: "/index.html", contents: HOME_HTML },
        { path: stale, contents: "console.log(1);" },
        { path: "/assets/site-9f8e7d.css", contents: STYLE },
      ],
      BEFORE,
    ),
    AFTER: writeTree(
      scratch(),
      [
        { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
        { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
        { path: "/assets/site-9f8e7d.css", contents: STYLE },
      ],
      AFTER,
    ),
    LATER: writeTree(
      scratch(),
      [
        { path: "/index.html", contents: "<!doctype html><title>Home, later</title>" },
        { path: "/assets/app-778899.js", contents: "console.log(3);" },
        { path: "/assets/site-9f8e7d.css", contents: STYLE },
      ],
      LATER,
    ),
  };

  const deploy = async (
    from: Manifest | undefined,
    to: Manifest,
    source: string,
  ): Promise<string[]> => {
    const lines: string[] = [];
    await runDeploy(
      {
        ...(from === undefined ? {} : { from }),
        to,
        source,
        origin,
        apply: true,
        pruneAfterUpload: true,
        now: new Date(to.build.createdAt),
        retention: {
          live: to,
          ...(from === undefined ? {} : { wasLive: from }),
          published: await listRetainedManifests(origin),
        },
      },
      (line) => lines.push(line),
    );
    return lines;
  };

  const first = await deploy(undefined, BEFORE, sources.BEFORE);
  expect(walk(origin)).toContain(stale);
  expect(first.join("\n")).toContain("Pruned nothing");

  const second = await deploy(BEFORE, AFTER, sources.AFTER);
  expect(walk(origin)).toContain(stale);
  expect(second.join("\n")).toContain("Pruned nothing");

  const third = await deploy(AFTER, LATER, sources.LATER);
  expect(walk(origin)).not.toContain(stale);
  expect(third.join("\n")).toContain(`prune  ${stale}`);
  expect(walk(origin)).toContain("/assets/app-d4e5f6.js");
});

// Handed to the prune anyway: this pins that the arithmetic deletes no live file
// even given a history it should never get (#287).
function neverDeployed(id: string, createdAt: string): Manifest {
  return manifestOf(id, createdAt, [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: `<!doctype html><title>${id}</title>`,
    },
  ]);
}

test("a build the origin never served cannot start another build's grace period", () => {
  const live1 = manifestOf("b1", "2026-01-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: HOME_HTML,
    },
    { path: "/live-chunk.js", kind: "js", contents: "console.log(1);" },
  ]);
  const deploying = manifestOf("b4", "2026-02-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Four</title>",
    },
    { path: "/new-chunk.js", kind: "js", contents: "console.log(4);" },
  ]);

  const prune = planRetainedPrune({
    live: deploying,
    wasLive: live1,
    retained: [
      live1,
      neverDeployed("b2", "2026-01-05T00:00:00.000Z"),
      neverDeployed("b3", "2026-01-10T00:00:00.000Z"),
      deploying,
    ],
    now: new Date(deploying.build.createdAt),
  });

  // Served until this deploy, so its window opens now. Blamed on b2 it would have
  // gone with no grace at all.
  expect(prune.due).toEqual([]);
  expect(prune.waiting).toEqual([
    {
      key: "/live-chunk.js",
      droppedBy: "b4",
      notBefore: "2026-02-08T00:00:00.000Z",
    },
  ]);
});

test("a build superseded by a rollback cannot start the restored build's grace period", () => {
  const restored = manifestOf("b2", "2026-01-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: HOME_HTML,
    },
    { path: "/c2.js", kind: "js", contents: "console.log(2);" },
  ]);
  const rolledBackFrom = manifestOf(
    "b3",
    "2026-01-02T00:00:00.000Z",
    [
      {
        path: "/index.html",
        kind: "html",
        page: { locale: "en", path: "/" },
        contents: "<!doctype html><title>Three</title>",
      },
      { path: "/c3.js", kind: "js", contents: "console.log(3);" },
    ],
    "b2",
  );
  const deploying = manifestOf(
    "b4",
    "2026-02-01T00:00:00.000Z",
    [
      {
        path: "/index.html",
        kind: "html",
        page: { locale: "en", path: "/" },
        contents: "<!doctype html><title>Four</title>",
      },
      { path: "/c4.js", kind: "js", contents: "console.log(4);" },
    ],
    "b2",
  );

  const prune = planRetainedPrune({
    live: deploying,
    wasLive: restored,
    retained: [restored, rolledBackFrom, deploying],
    now: new Date(deploying.build.createdAt),
  });

  expect(prune.waiting).toContainEqual({
    key: "/c2.js",
    droppedBy: "b4",
    notBefore: "2026-02-08T00:00:00.000Z",
  });
  expect(prune.waiting).toContainEqual({
    key: "/c3.js",
    droppedBy: "b4",
    notBefore: "2026-02-08T00:00:00.000Z",
  });
  expect(prune.due).toEqual([]);

  // The safety is a delay, not a leak: one deploy later both stale chunks go.
  const next = manifestOf(
    "b5",
    "2026-03-01T00:00:00.000Z",
    [
      {
        path: "/index.html",
        kind: "html",
        page: { locale: "en", path: "/" },
        contents: "<!doctype html><title>Five</title>",
      },
      { path: "/c5.js", kind: "js", contents: "console.log(5);" },
    ],
    "b4",
  );
  const later = planRetainedPrune({
    live: next,
    wasLive: deploying,
    retained: [restored, rolledBackFrom, deploying, next],
    now: new Date(next.build.createdAt),
  });

  expect(later.due.map((one) => one.key).sort()).toEqual(["/c2.js", "/c3.js"]);
  expect(later.waiting).toEqual([
    { key: "/c4.js", droppedBy: "b5", notBefore: "2026-03-08T00:00:00.000Z" },
  ]);
});

test("a re-deploy of an old artifact opens the window at the deploy, not at the stamp", () => {
  const old = manifestOf("old", "2025-12-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: HOME_HTML,
    },
  ]);
  const wasLive = manifestOf(
    "b3",
    "2026-01-03T00:00:00.000Z",
    [
      {
        path: "/index.html",
        kind: "html",
        page: { locale: "en", path: "/" },
        contents: "<!doctype html><title>Three</title>",
      },
      { path: "/c3.js", kind: "js", contents: "console.log(3);" },
    ],
    "old",
  );

  const prune = planRetainedPrune({
    live: old,
    wasLive,
    retained: [old, wasLive],
    now: new Date("2026-01-03T00:01:00.000Z"),
  });

  // Timed from the deploy, not the stamp, which would have made `/c3.js` due a month ago.
  expect(prune.due).toEqual([]);
  expect(prune.waiting).toEqual([
    {
      key: "/c3.js",
      droppedBy: "old",
      notBefore: "2026-01-10T00:01:00.000Z",
    },
  ]);
});

function withChunk(id: string, createdAt: string, chunk: string): Manifest {
  return manifestOf(id, createdAt, [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: `<!doctype html><title>${id}</title>`,
    },
    { path: chunk, kind: "js", contents: `console.log(${JSON.stringify(id)});` },
  ]);
}

const GATED = {
  b1: withChunk("b1", "2025-12-01T00:00:00.000Z", "/c1.js"),
  b2: withChunk("b2", "2026-01-01T00:00:00.000Z", "/c2.js"),
  b3: withChunk("b3", "2026-02-02T00:00:00.000Z", "/c3.js"),
  now: new Date("2026-02-02T00:00:00.000Z"),
};

test("a build stamped well before it was deployed gives the keys it supersedes their grace from the deploy", () => {
  const prune = planRetainedPrune({
    live: GATED.b3,
    wasLive: GATED.b2,
    retained: [GATED.b1, GATED.b2, GATED.b3],
    deployedAt: new Map([
      ["b1", new Date("2025-12-01T00:00:00.000Z")],
      ["b2", new Date("2026-02-01T00:00:00.000Z")],
    ]),
    now: GATED.now,
  });

  expect(prune.due).toEqual([]);
  expect(prune.waiting).toEqual([
    { key: "/c1.js", droppedBy: "b2", notBefore: "2026-02-08T00:00:00.000Z" },
    { key: "/c2.js", droppedBy: "b3", notBefore: "2026-02-09T00:00:00.000Z" },
  ]);
});

test("a build with no deploy instant on record is timed from its stamp, as before", () => {
  const input = {
    live: GATED.b3,
    wasLive: GATED.b2,
    retained: [GATED.b1, GATED.b2, GATED.b3],
    now: GATED.now,
  };
  const today = planRetainedPrune(input);

  expect(today.due).toEqual([
    { key: "/c1.js", droppedBy: "b2", notBefore: "2026-01-08T00:00:00.000Z" },
  ]);
  expect(planRetainedPrune({ ...input, deployedAt: new Map() })).toEqual(today);
  expect(
    planRetainedPrune({ ...input, deployedAt: new Map([["b2", new Date(Number.NaN)]]) }),
  ).toEqual(today);
});

test("re-deploying an old-stamped build over a newer history deletes nothing inside its grace", () => {
  const b2 = withChunk("b2", "2025-11-01T00:00:00.000Z", "/c2.js");
  const old = manifestOf("old", "2025-12-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: HOME_HTML,
    },
  ]);
  const b3 = withChunk("b3", "2026-01-03T00:00:00.000Z", "/c3.js");

  const prune = planRetainedPrune({
    live: old,
    wasLive: b3,
    retained: [b2, old, b3],
    deployedAt: new Map([
      ["b2", new Date("2025-11-01T00:00:00.000Z")],
      ["old", new Date("2026-01-01T00:00:00.000Z")],
      ["b3", new Date("2026-01-03T00:00:00.000Z")],
    ]),
    now: new Date("2026-01-05T00:00:00.000Z"),
  });

  expect(prune.due).toEqual([]);
  expect(prune.waiting).toEqual([
    { key: "/c2.js", droppedBy: "old", notBefore: "2026-01-12T00:00:00.000Z" },
    { key: "/c3.js", droppedBy: "old", notBefore: "2026-01-12T00:00:00.000Z" },
  ]);
});

test("re-deploying an artifact never deployed here times what the stamp walk blames on it from now", () => {
  const b2 = withChunk("b2", "2025-11-01T00:00:00.000Z", "/c2.js");
  const b3 = withChunk("b3", "2026-01-03T00:00:00.000Z", "/c3.js");
  const old = manifestOf("old", "2025-12-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: HOME_HTML,
    },
  ]);
  const now = new Date("2026-01-20T00:00:00.000Z");

  const prune = planRetainedPrune({
    live: old,
    wasLive: b3,
    retained: [b2, b3],
    deployedAt: new Map([
      ["b2", new Date("2025-11-01T00:00:00.000Z")],
      ["b3", new Date("2026-01-03T00:00:00.000Z")],
    ]),
    now,
  });

  expect(prune.due).toEqual([]);
  expect(prune.waiting).toEqual([
    { key: "/c2.js", droppedBy: "old", notBefore: "2026-01-27T00:00:00.000Z" },
    { key: "/c3.js", droppedBy: "old", notBefore: "2026-01-27T00:00:00.000Z" },
  ]);
});

function withPage(id: string, createdAt: string, chunk: string, page: string): Manifest {
  return manifestOf(id, createdAt, [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: `<!doctype html><title>${id}</title>`,
    },
    { path: chunk, kind: "js", contents: `console.log(${JSON.stringify(id)});` },
    {
      path: page,
      kind: "html",
      page: { locale: "en", path: page.replace(/index\.html$/, "") },
      contents: `<!doctype html><title>${page}</title>`,
    },
  ]);
}

test("a page the live build dropped is due at once, and a chunk it dropped keeps its grace (#555)", () => {
  const b1 = withPage("b1", "2026-01-01T00:00:00.000Z", "/c1.js", "/posts/retracted/index.html");
  const b2 = withChunk("b2", "2026-01-10T00:00:00.000Z", "/c2.js");
  const now = new Date("2026-01-11T00:00:00.000Z");

  const prune = planRetainedPrune({ live: b2, wasLive: b1, retained: [b1, b2], now });

  // A retracted page is no chunk a minute-old page asks for: it goes in this run (#555).
  expect(prune.due).toEqual([
    { key: "/posts/retracted/index.html", droppedBy: "b2", notBefore: "2026-01-11T00:00:00.000Z" },
  ]);
  expect(prune.waiting).toEqual([
    { key: "/c1.js", droppedBy: "b2", notBefore: "2026-01-18T00:00:00.000Z" },
  ]);
});

test("a page's zero grace opens where the blame puts it, not at a stamp (#555)", () => {
  const b2 = withPage("b2", "2025-11-01T00:00:00.000Z", "/c2.js", "/two/index.html");
  const b3 = withPage("b3", "2026-01-03T00:00:00.000Z", "/c3.js", "/three/index.html");
  const old = manifestOf("old", "2025-12-01T00:00:00.000Z", [
    {
      path: "/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: HOME_HTML,
    },
  ]);
  const now = new Date("2026-01-20T00:00:00.000Z");

  const prune = planRetainedPrune({
    live: old,
    wasLive: b3,
    retained: [b2, b3],
    deployedAt: new Map([
      ["b2", new Date("2025-11-01T00:00:00.000Z")],
      ["b3", new Date("2026-01-03T00:00:00.000Z")],
    ]),
    now,
  });

  expect(prune.due).toEqual([
    { key: "/three/index.html", droppedBy: "old", notBefore: "2026-01-20T00:00:00.000Z" },
    { key: "/two/index.html", droppedBy: "old", notBefore: "2026-01-20T00:00:00.000Z" },
  ]);
  expect(prune.waiting).toEqual([
    { key: "/c2.js", droppedBy: "old", notBefore: "2026-01-27T00:00:00.000Z" },
    { key: "/c3.js", droppedBy: "old", notBefore: "2026-01-27T00:00:00.000Z" },
  ]);
});

function recording(root: string): { target: DeployTarget; puts: { key: string; body: string }[] } {
  const inner = filesystemTarget(root);
  const puts: { key: string; body: string }[] = [];
  return {
    puts,
    target: {
      name: inner.name,
      async put(key, body, metadata) {
        puts.push({ key, body: Buffer.from(body).toString("utf8") });
        await inner.put(key, body, metadata);
      },
      delete: (key) => inner.delete(key),
    },
  };
}

test("an apply puts the history document, then the deploy instant, then the manifest, and the first and last are the same bytes", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
      { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    AFTER,
  );
  const origin = scratch();
  const plan = planDeploy({ from: BEFORE, to: AFTER });
  const { target, puts } = recording(origin);

  const report = await applyPlan(plan, {
    source,
    target,
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  expect(report.deployInstant).toBe(deployInstantKey("build-02"));
  expect(puts.map((one) => one.key).slice(-4)).toEqual([
    retainedKey("build-02"),
    deployInstantKey("build-02"),
    HISTORY_INDEX_KEY,
    MANIFEST_KEY,
  ]);
  expect(report.uploaded).toEqual(puts.map((one) => one.key));
  const [retained, instant, , manifest] = puts.slice(-4);
  expect(retained?.body).toBe(manifest?.body);
  expect(manifest?.body).toBe(readFileSync(join(source, "manifest.json"), "utf8"));
  expect(instant?.body).toBe("2026-09-01T12:00:00.000Z\n");

  await applyPlan(plan, { source, target, now: new Date("2026-09-20T08:00:00.000Z") });
  expect(readFileSync(join(origin, RETENTION_DIR, "build-02.deployed-at"), "utf8")).toBe(
    "2026-09-20T08:00:00.000Z\n",
  );
  expect(readFileSync(join(origin, RETENTION_DIR, "build-02.json"), "utf8")).toBe(
    readFileSync(join(origin, "manifest.json"), "utf8"),
  );
});

test("an apply names the history's builds and its own in the origin's history index, after its instant and before the manifest (#659)", async () => {
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: "<!doctype html><title>Home, revised</title>" },
      { path: "/assets/app-d4e5f6.js", contents: "console.log(2);" },
      { path: "/assets/site-9f8e7d.css", contents: STYLE },
    ],
    AFTER,
  );
  const origin = scratch();
  const plan = planDeploy({ from: BEFORE, to: AFTER });
  const { target, puts } = recording(origin);

  const report = await applyPlan(plan, { source, target, history: ["build-01", "build-00", "build-01"] });

  expect(report.index).toBe(HISTORY_INDEX_KEY);
  expect(HISTORY_INDEX_KEY).toBe("/.pagedeck/deploy-history.json");
  expect(puts.map((one) => one.key).slice(-3)).toEqual([deployInstantKey("build-02"), HISTORY_INDEX_KEY, MANIFEST_KEY]);
  const index = puts.find((one) => one.key === HISTORY_INDEX_KEY)?.body;
  expect(index).toBe('{"builds":["build-00","build-01","build-02"]}\n');
  expect(readHistoryIndex(index as string)).toEqual(["build-00", "build-01", "build-02"]);

  const again = recording(origin);
  await applyPlan(plan, { source, target: again.target, history: ["build-02"] });
  expect(again.puts.find((one) => one.key === HISTORY_INDEX_KEY)?.body).toBe('{"builds":["build-02"]}\n');
});

test("a history index that is not a list of build ids is refused, and none of its text is quoted (#659)", () => {
  const fix =
    'rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named';
  const refused = (text: string): Error => {
    try {
      readHistoryIndex(text);
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the index to be refused");
  };
  for (const [text, reason] of [
    ['{"builds": ["b1", "secret-in-a-bad-file"', "is not valid JSON"],
    ['["b1"]', 'is not an object with a "builds" list'],
    ['{"builds": "b1"}', 'is not an object with a "builds" list'],
    ['{"builds": ["b1", 7]}', "entry 2 is not a build id a document can be filed under"],
    ['{"builds": ["b1", "../secret-in-a-bad-file"]}', "entry 2 is not a build id a document can be filed under"],
    ['{"builds": ["b1", "a/b"]}', "entry 2 is not a build id a document can be filed under"],
    ['{"builds": [".hidden"]}', "entry 1 is not a build id a document can be filed under"],
    ['{"builds": [""]}', "entry 1 is not a build id a document can be filed under"],
  ] as const) {
    const error = refused(text);
    expect(error, text).toBeInstanceOf(ConfigError);
    expect(error.message, text).toBe(`Deploy history index "/.pagedeck/deploy-history.json": ${reason} — ${fix}`);
    expect(error.message).not.toContain("secret-in-a-bad-file");
  }
  expect(readHistoryIndex('{"builds": []}')).toEqual([]);
});

test("a retained manifest naming a key outside the origin is left out of its history, and the directory prune touches nothing outside it (#659)", async () => {
  const root = scratch();
  const origin = join(root, "origin");
  const sentinel = join(root, "sentinel.txt");
  writeFileSync(sentinel, "outside\n");
  const source = writeTree(scratch(), [{ path: "/index.html", contents: HOME_HTML }], BEFORE);
  await applyPlan({ ...planDeploy({ to: BEFORE }), trees: [] }, { source, target: filesystemTarget(origin) });
  writeTree(origin, [{ path: "/index.html", contents: HOME_HTML }]);
  const crafted = manifestOf("build-00", "2026-08-01T00:00:00.000Z", [
    { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: HOME_HTML },
  ]);
  writeFileSync(
    join(origin, RETENTION_DIR, "build-00.json"),
    JSON.stringify({
      ...crafted,
      files: [
        ...crafted.files,
        { path: "/../sentinel.txt", kind: "asset", hash: "0", size: 1 },
        { path: "/assets/../index.html", kind: "asset", hash: "0", size: 1 },
      ],
    }),
  );

  const published = await listRetainedManifests(origin);
  expect(published.map((one) => one.build.id)).toEqual(["build-01"]);
  await runDeploy(
    {
      from: BEFORE,
      to: BEFORE,
      source,
      origin,
      apply: true,
      pruneAfterUpload: true,
      now: new Date("2027-01-01T00:00:00.000Z"),
      retention: { live: BEFORE, wasLive: BEFORE, published },
    },
    () => undefined,
  );
  expect(readFileSync(sentinel, "utf8")).toBe("outside\n");
  expect(walk(origin)).toContain("/index.html");

  const error = await refusal(filesystemTarget(origin).delete("/../sentinel.txt"));
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    `Deploy of "/../sentinel.txt": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, so it could name a file outside the origin at "${origin}"`,
  );
  await expect(
    filesystemTarget(origin).put("/assets/../../sentinel.txt", Buffer.from("x"), documentMetadata("/x.txt")),
  ).rejects.toThrow(ConfigError);
  expect(readFileSync(sentinel, "utf8")).toBe("outside\n");
});

test.each([
  ["CR", "\r"],
  ["LF", "\n"],
  ["ESC", "\u001b"],
  ["DEL", "\u007f"],
  ["U+0085", "\u0085"],
])("a retained manifest whose file key holds a %s is left out of a directory origin's history, so no plan line carries it (#674)", async (_name, control) => {
  const origin = join(scratch(), "origin");
  const source = writeTree(scratch(), [{ path: "/index.html", contents: HOME_HTML }], BEFORE);
  await applyPlan({ ...planDeploy({ to: BEFORE }), trees: [] }, { source, target: filesystemTarget(origin) });
  const crafted = manifestOf("build-00", "2026-08-01T00:00:00.000Z", [
    { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: HOME_HTML },
  ]);
  writeFileSync(
    join(origin, RETENTION_DIR, "build-00.json"),
    JSON.stringify({ ...crafted, files: [...crafted.files, { path: `/old${control}.txt`, kind: "asset", hash: "0", size: 1 }] }),
  );

  const published = await listRetainedManifests(origin);
  const lines: string[] = [];
  await runDeploy(
    {
      from: BEFORE,
      to: BEFORE,
      source,
      origin,
      pruneAfterUpload: true,
      now: new Date("2027-01-01T00:00:00.000Z"),
      retention: { live: BEFORE, wasLive: BEFORE, published },
    },
    (line) => lines.push(line),
  );
  expect(lines).toContainEqual(expect.stringMatching(/^ {2}\d+ to prune, /));
  expect(lines.filter((line) => line.includes(control))).toEqual([]);
  expect(published.map((one) => one.build.id)).toEqual(["build-01"]);
});

test("a history index is bounded by the builds it can name and the ids a file name can hold, and each cap is named (#659)", () => {
  expect(BUILD_ID_MAX_BYTES).toBe(255 - ".deployed-at".length);
  const fix =
    'rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named';
  const longest = "b".repeat(BUILD_ID_MAX_BYTES);
  expect(readHistoryIndex(JSON.stringify({ builds: [longest] }))).toEqual([longest]);
  expect(() => readHistoryIndex(JSON.stringify({ builds: ["b1", `${longest}b`] }))).toThrow(
    new ConfigError(
      `Deploy history index "/.pagedeck/deploy-history.json": entry 2 is a build id of 244 bytes, longer than the 243 a "<build id>.deployed-at" file name can hold — ${fix}`,
    ),
  );
  expect(() => readHistoryIndex(JSON.stringify({ builds: ["é".repeat(122)] }))).toThrow(/entry 1 is a build id of 244 bytes/);
  const ids = Array.from({ length: HISTORY_INDEX_MAX_BUILDS + 1 }, (_, n) => `b${String(n)}`);
  expect(() => readHistoryIndex(JSON.stringify({ builds: ids }))).toThrow(
    new ConfigError(
      `Deploy history index "/.pagedeck/deploy-history.json": names 100001 builds, more than the 100000 an index holds — ${fix}`,
    ),
  );
  expect(readHistoryIndex(JSON.stringify({ builds: ids.slice(1) }))).toHaveLength(HISTORY_INDEX_MAX_BUILDS);
});

const TYPED = manifestOf("build-typed", "2026-09-02T00:00:00.000Z", [
  { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: HOME_HTML },
  { path: "/assets/app-C52oINTW.js", kind: "js", hashed: true, contents: "console.log(3);" },
  { path: "/downloads/notes.tar.zst", kind: "asset", contents: "zst" },
]);

function typedTree(): string {
  return writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/assets/app-C52oINTW.js", contents: "console.log(3);" },
      { path: "/downloads/notes.tar.zst", contents: "zst" },
    ],
    TYPED,
  );
}

test("every object an apply puts carries the type and cache policy the deploy decided (#560)", async () => {
  const puts: { key: string; metadata: ObjectMetadata }[] = [];
  const inner = filesystemTarget(scratch());
  const target: DeployTarget = {
    name: inner.name,
    async put(key, body, metadata) {
      puts.push({ key, metadata });
      await inner.put(key, body, metadata);
    },
    delete: (key) => inner.delete(key),
  };
  const edge: EdgeOutput = {
    target: "netlify",
    artifacts: [
      { role: "tree-file", path: "/_redirects", contents: "/old /new 301\n" },
      { role: "tree-file", path: "/_headers", contents: "/*\n  X-Frame-Options: DENY\n" },
    ],
  };
  const report = await applyPlan(planDeploy({ to: TYPED, edge }), { source: typedTree(), target });

  const text = "text/plain; charset=utf-8";
  const json = "application/json; charset=utf-8";
  expect(puts).toEqual([
    {
      key: "/assets/app-C52oINTW.js",
      metadata: {
        contentType: "text/javascript; charset=utf-8",
        cacheControl: "public, max-age=31536000, immutable",
      },
    },
    {
      key: "/downloads/notes.tar.zst",
      metadata: { contentType: "application/octet-stream", cacheControl: "no-cache" },
    },
    { key: "/index.html", metadata: { contentType: "text/html; charset=utf-8", cacheControl: "no-cache" } },
    { key: "/_redirects", metadata: { contentType: text, cacheControl: "no-cache" } },
    { key: "/_headers", metadata: { contentType: text, cacheControl: "no-cache" } },
    { key: retainedKey("build-typed"), metadata: { contentType: json, cacheControl: "no-cache" } },
    { key: deployInstantKey("build-typed"), metadata: { contentType: text, cacheControl: "no-cache" } },
    { key: HISTORY_INDEX_KEY, metadata: { contentType: json, cacheControl: "no-cache" } },
    { key: MANIFEST_KEY, metadata: { contentType: json, cacheControl: "no-cache" } },
  ]);
  expect(report.untyped).toEqual(["/downloads/notes.tar.zst"]);
});

test("a deploy names each file it sent as application/octet-stream (#560)", async () => {
  const lines: string[] = [];
  await runDeploy(
    { to: TYPED, source: typedTree(), origin: scratch(), apply: true },
    (line) => lines.push(line),
  );
  expect(lines).toContain(
    "Deploy: sent 1 file as application/octet-stream, because the deploy knows no type for its extension, so a browser downloads it rather than showing it — rename the file, or add its extension to the table in packages/site/src/deploy-metadata.ts:",
  );
  expect(lines).toContain('  "/downloads/notes.tar.zst"');
});

test("a deploy names every file it sent as application/octet-stream under one plural headline (#560)", async () => {
  const two = manifestOf("build-untyped", "2026-09-03T00:00:00.000Z", [
    { path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: HOME_HTML },
    { path: "/downloads/a.zst", kind: "asset", contents: "a" },
    { path: "/LICENSE", kind: "asset", contents: "b" },
  ]);
  const source = writeTree(
    scratch(),
    [
      { path: "/index.html", contents: HOME_HTML },
      { path: "/downloads/a.zst", contents: "a" },
      { path: "/LICENSE", contents: "b" },
    ],
    two,
  );
  const lines: string[] = [];
  await runDeploy({ to: two, source, origin: scratch(), apply: true }, (line) => lines.push(line));
  const at = lines.indexOf(
    "Deploy: sent 2 files as application/octet-stream, because the deploy knows no type for their extensions, so a browser downloads them rather than showing them — rename the files, or add their extensions to the table in packages/site/src/deploy-metadata.ts:",
  );
  expect(at).toBeGreaterThan(-1);
  expect(lines.slice(at + 1, at + 3).sort()).toEqual(['  "/LICENSE"', '  "/downloads/a.zst"']);
});

test("a deploy instant reads back as the UTC instant it spells, and as nothing otherwise", () => {
  const instant = new Date("2026-09-01T12:00:00.000Z");
  for (const text of [
    "2026-09-01T12:00:00.000Z\n",
    "2026-09-01T12:00:00.000Z",
    "2026-09-01T12:00:00Z",
    "2026-09-01T12:00:00Z\n",
    "2026-09-01T12:00:00+00:00",
  ]) {
    expect(readDeployInstant(text)).toEqual(instant);
  }
  expect(readDeployInstant("2026-09-01T12:00:00.5Z")).toEqual(
    new Date("2026-09-01T12:00:00.500Z"),
  );
  for (const text of [
    "",
    "\n",
    "yesterday",
    "2026-09-01",
    "2026-09-01T12:00:00",
    "2026-09-01T12:00:00+02:00",
    "1756728000000",
    "2026-02-30T00:00:00Z",
    "2026-09-01T24:00:00Z",
    '{"at":"2026-09-01T12:00:00.000Z"}',
  ]) {
    expect(readDeployInstant(text)).toBeUndefined();
  }
});

test("the retention store reads an origin holding deploy instants as manifests only, and warns about none of them", async () => {
  const origin = scratch();
  for (const manifest of [BEFORE, AFTER]) {
    const source = writeTree(scratch(), [], manifest);
    await applyPlan(
      { ...planDeploy({ to: manifest }), trees: [] },
      { source, target: filesystemTarget(origin), now: new Date(manifest.build.createdAt) },
    );
  }
  writeFileSync(join(origin, RETENTION_DIR, "build-00.deployed-at"), "not an instant\n");

  expect((await listRetainedManifests(origin)).map((one) => one.build.id)).toEqual([
    "build-02",
    "build-01",
  ]);
  expect(await retainManifest(origin, LATER)).toBeUndefined();
  expect(walk(origin).filter((path) => path.startsWith(`/${RETENTION_DIR}/`))).toEqual([
    `/${RETENTION_DIR}/build-00.deployed-at`,
    `/${RETENTION_DIR}/build-01.deployed-at`,
    `/${RETENTION_DIR}/build-01.json`,
    `/${RETENTION_DIR}/build-02.deployed-at`,
    `/${RETENTION_DIR}/build-02.json`,
    `/${RETENTION_DIR}/build-10.json`,
  ]);
});

test("a deploy instant the runnable could not read is reported with the plan, and the prune falls back to the stamp", async () => {
  const lines: string[] = [];
  const code = await runDeploy(
    {
      from: GATED.b2,
      to: GATED.b3,
      source: scratch(),
      origin: scratch(),
      now: GATED.now,
      retention: {
        live: GATED.b3,
        wasLive: GATED.b2,
        published: [GATED.b1, GATED.b2],
        deployedAt: new Map(),
        unreadableDeployInstants: [
          { key: deployInstantKey("b2"), reason: "it holds no ISO-8601 instant" },
        ],
      },
    },
    (line) => lines.push(line),
  );

  expect(code).toBe(0);
  expect(lines).toContain("    due    /c1.js (dropped by \"b2\", since 2026-01-08T00:00:00.000Z)");
  expect(lines).toContain(
    "Deploy history: 1 deploy instant at the origin could not be read, so the keys its build dropped are timed from that build's stamp, which can be earlier than the build was deployed and so shortens their grace — rewrite the file as the ISO-8601 UTC instant the build was deployed, or delete it to accept the stamp:",
  );
  expect(lines).toContain('  "/.pagedeck/manifests/b2.deployed-at": it holds no ISO-8601 instant');
  expect(lines.at(-1)).toContain("DRY RUN");
});
