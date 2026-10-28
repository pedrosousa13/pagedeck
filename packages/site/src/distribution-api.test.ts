import { afterEach, beforeEach, expect, test } from "vitest";
import { ConfigError } from "@pagedeck/core";
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { applyDistributionConfig } from "./distribution-api.js";
import type { DistributionFragment } from "./distribution-config.js";
import { ACCESS, RECORDED, startFakeCloudFront } from "./fake-cloudfront.test-support.js";
import type { FakeCloudFront } from "./fake-cloudfront.test-support.js";

const ID = "E2EXAMPLE";

const FRAGMENTS: DistributionFragment[] = cloudfront()
  .compile({
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      { redirects: [], notFound: "/404", headers: [], upstreams: [{ prefix: "/api/", url: "https://app.example.net" }] },
    ],
  })
  .artifacts.filter((artifact) => artifact.role === "distribution-config")
  .map(({ path, contents }) => ({ path, contents }));

let fake: FakeCloudFront;
let endpoint: string;
let seen: FakeCloudFront["seen"];
const stored = (): { xml: string; version: number } => fake.stored.get(ID) as { xml: string; version: number };

beforeEach(async () => {
  fake = await startFakeCloudFront([ID]);
  endpoint = fake.endpoint;
  seen = fake.seen;
});

afterEach(async () => {
  await fake.close();
});

async function run(apply: boolean, distributionId = ID): Promise<string[]> {
  const lines: string[] = [];
  await applyDistributionConfig({
    endpoint,
    access: ACCESS,
    distributionId,
    fragments: FRAGMENTS,
    apply,
    write: (line) => lines.push(line),
  });
  return lines;
}

test("a dry run reads the config, prints the merged config, and sends no update", async () => {
  const lines = await run(false);
  expect(seen.map(({ method }) => method)).toEqual(["GET"]);
  expect(stored().xml).toBe(RECORDED);
  const printed = lines.join("\n");
  expect(printed).toContain("Distribution E2EXAMPLE: 1 Pagedeck origin, 2 Pagedeck cache behaviors");
  expect(printed).toContain("<PathPattern>/api/*</PathPattern>");
  expect(printed).toContain("<Quantity>3</Quantity>");
  expect(lines.at(-1)).toBe("DRY RUN: distribution E2EXAMPLE is not updated. Pass --apply to send this config.");
});

test("applying twice updates once, under the ETag it read, and the second run sends nothing", async () => {
  await run(true);
  expect(seen.map(({ method }) => method)).toEqual(["GET", "PUT"]);
  expect(seen[1]?.headers["if-match"]).toBe("E1");
  expect(stored().version).toBe(2);
  expect(stored().xml).toContain("<PathPattern>/api/*</PathPattern>");

  const second = await run(true);
  expect(seen.map(({ method }) => method)).toEqual(["GET", "PUT", "GET"]);
  expect(stored().version).toBe(2);
  expect(second).toEqual(["Distribution E2EXAMPLE: unchanged — its config already holds these fragments."]);
});

test("a config changed between the read and the update is refused, not overwritten", async () => {
  fake.beforePut = () => {
    fake.stored.set(ID, { ...stored(), version: stored().version + 1 });
  };
  const failure = run(true);
  await expect(failure).rejects.toBeInstanceOf(ConfigError);
  await expect(failure).rejects.toThrow(
    "Distribution E2EXAMPLE: UpdateDistribution answered 412 PreconditionFailed — the config changed after this deploy read it; run the deploy again, which reads it afresh",
  );
});

test("an unknown distribution is named, and no credential reaches the message", async () => {
  const failure = run(false, "ENOPE");
  await expect(failure).rejects.toThrow(
    "Distribution ENOPE: GetDistributionConfig answered 404 NoSuchDistribution — check the distribution id",
  );
  const message = await failure.catch((error: unknown) => (error as Error).message);
  expect(message).not.toContain(ACCESS.secretKey);
  expect(message).not.toContain(ACCESS.accessKey);
});
