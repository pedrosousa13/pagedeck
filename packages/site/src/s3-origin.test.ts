import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  caTrustUnavailable,
  docker,
  dockerUnavailable,
  opensslUnavailable,
  ORIGIN_SUBNET,
} from "./s3-origin.test-support.js";

const DEAD_DAEMON = {
  ...process.env,
  DOCKER_HOST: `unix://${join(tmpdir(), "pagedeck-origin-harness-no-such-daemon.sock")}`,
};

test("the Docker probe answers with a reason and a fix, rather than throwing, when no daemon is reachable", async () => {
  const reason = await dockerUnavailable(DEAD_DAEMON);
  expect(reason).toMatch(/^Docker is not available — /);
  expect(reason).toMatch(
    /the origin harness needs a Docker daemon it can start the S3 origin on — start a Docker daemon, or point DOCKER_HOST at one$/,
  );
}, 30_000);

test("the openssl probe answers with a reason and a fix when there is no openssl to run", async () => {
  const reason = await opensslUnavailable({ ...process.env, PATH: "" });
  expect(reason).toMatch(/^openssl is not available — /);
  expect(reason).toMatch(
    /the origin harness mints the run's TLS certificate with it — install openssl, or put it on PATH$/,
  );
}, 30_000);

test("the CA trust probe answers with the Node it needs when tls cannot extend the default CA list", () => {
  expect(caTrustUnavailable({})).toBe(
    `Node ${process.version} cannot extend the default CA list (tls.setDefaultCACertificates) — the origin harness trusts the run's certificate that way; run it on Node 24.5 or later`,
  );
  expect(
    caTrustUnavailable({ getCACertificates: () => [], setDefaultCACertificates: () => undefined }),
  ).toBeUndefined();
});

test("a failed docker command names itself, the subnet it asked for, and how to free it", async () => {
  const error: unknown = await docker(
    ["network", "create", "--subnet", ORIGIN_SUBNET, "pagedeck-origin-harness-never"],
    DEAD_DAEMON,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(/^Origin harness: docker network create failed — /);
  expect(message).toContain(
    `if a network this machine already has overlaps ORIGIN_SUBNET (${ORIGIN_SUBNET}), remove a leftover one with docker network rm (docker network ls --filter label=pagedeck.harness=origin lists them), or change ORIGIN_SUBNET in packages/site/src/s3-origin.test-support.ts`,
  );
  expect((error as Error).cause).toBeDefined();
}, 30_000);

test("any other failed docker command names itself and where to look", async () => {
  const error: unknown = await docker(["start", "pagedeck-origin-harness-never"], DEAD_DAEMON).catch(
    (caught: unknown) => caught,
  );
  expect((error as Error).message).toMatch(
    /^Origin harness: docker start failed — .+; check that the Docker daemon is running, and find anything a killed run left with docker ps -a --filter label=pagedeck\.harness=origin$/,
  );
}, 30_000);
