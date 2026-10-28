import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildManifest, ConfigError, planEntries, planRouting, planTiers } from "@pagedeck/core";
import type { Manifest, Page } from "@pagedeck/core";
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { filesystemTarget } from "./deploy-target.js";
import type { DeployTarget } from "./deploy-target.js";
import { runDeploy } from "./deploy-run.js";
import { readDistributions } from "./deploy-distribution.js";
import type { Distributions } from "./deploy-distribution.js";
import { ACCESS, RECORDED, startFakeCloudFront } from "./fake-cloudfront.test-support.js";
import type { FakeCloudFront } from "./fake-cloudfront.test-support.js";

const ENV = {
  PAGEDECK_CLOUDFRONT_ACCESS_KEY_ID: ACCESS.accessKey,
  PAGEDECK_CLOUDFRONT_SECRET_ACCESS_KEY: ACCESS.secretKey,
};

const HOME: Page = { locale: "en", path: "/", output: "/", dependencies: [] };

const MANIFEST: Manifest = (() => {
  const entries = planEntries([{ page: HOME, islands: [] }], { modules: {} });
  return buildManifest({
    build: { id: "build-01", createdAt: "2026-10-28T10:00:00.000Z" },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [HOME], trailingSlash: "never" }),
    pages: [HOME],
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs: [{ path: "/index.html", kind: "html", page: { locale: "en", path: "/" }, contents: "home" }],
  });
})();

const UPSTREAM_TREE = {
  redirects: [],
  notFound: "/404",
  headers: [],
  upstreams: [{ prefix: "/api/", url: "https://app.example.net" }],
};

function edgeOf(trees: RoutingManifest["trees"]): ReturnType<ReturnType<typeof cloudfront>["compile"]> {
  return cloudfront().compile({ version: ROUTING_VERSION, site: { trailingSlash: "never" }, trees });
}

const scratches: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-deploy-distribution-"));
  scratches.push(dir);
  return dir;
}

let fake: FakeCloudFront;
let uploads: string[];

beforeEach(async () => {
  fake = await startFakeCloudFront(["E2EXAMPLE", "E3SHOP"]);
  uploads = [];
});

afterEach(async () => {
  await fake.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function source(): string {
  const dir = scratch();
  writeFileSync(join(dir, "index.html"), "home");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  return dir;
}

// Each upload, with how many API requests the fake had answered when it started.
function recording(origin: string): DeployTarget {
  const inner = filesystemTarget(origin);
  return {
    name: inner.name,
    async put(key, body, metadata) {
      uploads.push(`${key} after ${String(fake.seen.length)} requests`);
      await inner.put(key, body, metadata);
    },
    delete: (key) => inner.delete(key),
  };
}

async function deploy(options: {
  apply: boolean;
  edge: ReturnType<typeof edgeOf>;
  ids: Distributions["ids"];
  origin?: string;
  staging?: string;
}): Promise<{ lines: string[]; origin: string }> {
  const origin = options.origin ?? scratch();
  const lines: string[] = [];
  const distributions: Distributions = { ids: options.ids, access: ACCESS, endpoint: fake.endpoint };
  await runDeploy(
    {
      to: MANIFEST,
      edge: options.edge,
      source: source(),
      origin,
      apply: options.apply,
      target: recording(origin),
      ...(options.staging === undefined ? {} : { staging: options.staging }),
      distributions,
    },
    (line) => lines.push(line),
  );
  return { lines, origin };
}

test("--distribution takes a bare id for the default tree and <tree>=<id> for a domain tree", () => {
  const read = readDistributions(["E2EXAMPLE", "shop.example=E3SHOP"], { ...ENV, PAGEDECK_CLOUDFRONT_SESSION_TOKEN: "tok" }, "cloudfront-function");
  expect([...read.ids]).toEqual([
    [undefined, "E2EXAMPLE"],
    ["shop.example", "E3SHOP"],
  ]);
  expect(read.access).toEqual({ ...ACCESS, sessionToken: "tok" });
});

test("--distribution without a credential, twice for a tree, empty, or without the cloudfront edge is refused, every fault at once", () => {
  const read = (): unknown => readDistributions(["E1", "E2", "shop.example="], {}, "netlify");
  expect(read).toThrow(ConfigError);
  expect(read).toThrow(
    [
      'Option "--distribution" names the default tree twice, as "E1" and as "E2" — two sources for one value are refused rather than ranked; pass it once.',
      'Option "--distribution" is given "shop.example=", which names no distribution — pass a distribution id for the default tree, or <tree>=<id> for a domain tree.',
      'Option "--distribution" applies the cloudfront-function adapter\'s distribution-config fragments, and --edge is "netlify" — pass --edge cloudfront-function, or drop --distribution.',
      'Option "--distribution" calls CloudFront\'s API, and PAGEDECK_CLOUDFRONT_ACCESS_KEY_ID and PAGEDECK_CLOUDFRONT_SECRET_ACCESS_KEY are not set — set both to a credential allowed cloudfront:GetDistributionConfig and cloudfront:UpdateDistribution, and PAGEDECK_CLOUDFRONT_SESSION_TOKEN beside them for a temporary one.',
    ].join("\n"),
  );
});

test("a dry run reads the recorded config, prints the merged config, and updates and uploads nothing", async () => {
  const { lines, origin } = await deploy({ apply: false, edge: edgeOf([UPSTREAM_TREE]), ids: new Map([[undefined, "E2EXAMPLE"]]) });
  expect(fake.seen.map(({ method }) => method)).toEqual(["GET"]);
  expect(fake.stored.get("E2EXAMPLE")?.xml).toBe(RECORDED);
  expect(readdirSync(origin)).toEqual([]);
  const printed = lines.join("\n");
  expect(printed).toContain("Distribution E2EXAMPLE: 1 Pagedeck origin, 2 Pagedeck cache behaviors and 1 Pagedeck error response go ahead of the operator's");
  expect(printed).toContain("<PathPattern>/api/*</PathPattern>");
  expect(printed).toContain("Dry run: distribution E2EXAMPLE is not updated. Pass --apply to send this config.");
  expect(lines.at(-1)).toContain("DRY RUN: nothing was uploaded");
  expect(lines).toContain("    stage  upstreams.json (distribution-config) — merged into distribution E2EXAMPLE before the upload");
});

test("a staged path outside the staging directory is refused before the distribution is read", async () => {
  const compiled = edgeOf([UPSTREAM_TREE]);
  const edge = {
    ...compiled,
    artifacts: [...compiled.artifacts, { domain: "../../x", role: "edge-module" as const, path: "worker.js", contents: "escaped" }],
  };
  const run = deploy({ apply: true, edge, ids: new Map([[undefined, "E2EXAMPLE"]]), staging: join(scratch(), "a", "b") });
  await expect(run).rejects.toThrow("would be staged outside the staging directory");
  expect(fake.seen).toEqual([]);
  expect(uploads).toEqual([]);
});

test("an apply updates the distribution before any upload, and a second apply sends no update", async () => {
  const ids = new Map([[undefined, "E2EXAMPLE"]]);
  const { origin } = await deploy({ apply: true, edge: edgeOf([UPSTREAM_TREE]), ids });
  expect(uploads[0]).toBe("/index.html after 2 requests");
  expect(fake.stored.get("E2EXAMPLE")?.version).toBe(2);

  const { lines } = await deploy({ apply: true, edge: edgeOf([UPSTREAM_TREE]), ids, origin });
  expect(fake.seen.map(({ method }) => method)).toEqual(["GET", "PUT", "GET"]);
  expect(fake.stored.get("E2EXAMPLE")?.version).toBe(2);
  expect(lines).toContain("Distribution E2EXAMPLE: unchanged — its config already holds these fragments.");
});

test("each tree's fragments go to its own distribution", async () => {
  await deploy({
    apply: true,
    edge: edgeOf([UPSTREAM_TREE, { ...UPSTREAM_TREE, domain: "shop.example" }]),
    ids: new Map([
      [undefined, "E2EXAMPLE"],
      ["shop.example", "E3SHOP"],
    ]),
  });
  expect(fake.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "GET /2020-05-31/distribution/E2EXAMPLE/config",
    "PUT /2020-05-31/distribution/E2EXAMPLE/config",
    "GET /2020-05-31/distribution/E3SHOP/config",
    "PUT /2020-05-31/distribution/E3SHOP/config",
  ]);
});

test("a refused update uploads nothing, and every distribution's failure is reported", async () => {
  const origin = scratch();
  const run = deploy({
    apply: true,
    origin,
    edge: edgeOf([UPSTREAM_TREE, { ...UPSTREAM_TREE, domain: "shop.example" }]),
    ids: new Map([
      [undefined, "ENOPE"],
      ["shop.example", "ENOPE2"],
    ]),
  });
  await expect(run).rejects.toBeInstanceOf(ConfigError);
  await expect(run).rejects.toThrow(
    [
      "Distribution ENOPE: GetDistributionConfig answered 404 NoSuchDistribution — check the distribution id",
      "Distribution ENOPE2: GetDistributionConfig answered 404 NoSuchDistribution — check the distribution id",
    ].join("\n"),
  );
  expect(readdirSync(origin)).toEqual([]);
});

test("a tree with no fragment, or no tree of that name, is refused before any request", async () => {
  const run = deploy({
    apply: false,
    edge: edgeOf([
      { redirects: [], headers: [], upstreams: [] },
      { ...UPSTREAM_TREE, domain: "shop.example" },
    ]),
    ids: new Map([
      [undefined, "E2EXAMPLE"],
      ["nope.example", "E3SHOP"],
    ]),
  });
  await expect(run).rejects.toThrow(
    [
      'Distribution E2EXAMPLE: the default tree has no distribution-config fragment to apply, since its routing declares no upstream and no notFound page — drop it from --distribution, or name a tree that has one: "shop.example"',
      'Distribution E3SHOP: the build has no tree "nope.example" — name one of its trees: (default), "shop.example"',
    ].join("\n"),
  );
  expect(fake.seen).toEqual([]);
});
