import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A namespace import: a Node without `setDefaultCACertificates` refuses a named
// import at link time, before `caTrustUnavailable` can say so.
import * as tls from "node:tls";
import { promisify } from "node:util";
import type { S3Access } from "./sigv4.test-support.js";

const execFileAsync = promisify(execFile);

// Pinned by tag and digest, never `:latest` (#302).
export const ORIGIN_IMAGE =
  "chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882";

export const ORIGIN_SUBNET = "172.16.93.0/24";
export const ORIGIN_IP = "172.16.93.10";

const ORIGIN_PORT = 9000;

export const HARNESS_LABEL = "pagedeck.harness=origin";

const READY_TIMEOUT_MS = 60_000;

export async function docker(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, { env, timeout: 300_000 });
    return stdout.trim();
  } catch (cause) {
    const command = args.slice(0, args[0] === "network" ? 2 : 1).join(" ");
    const fix =
      command === "network create"
        ? `if a network this machine already has overlaps ORIGIN_SUBNET (${ORIGIN_SUBNET}), remove a leftover one with docker network rm (docker network ls --filter label=${HARNESS_LABEL} lists them), or change ORIGIN_SUBNET in packages/site/src/s3-origin.test-support.ts`
        : `check that the Docker daemon is running, and find anything a killed run left with docker ps -a --filter label=${HARNESS_LABEL}`;
    throw new Error(`Origin harness: docker ${command} failed — ${firstLine(cause)}; ${fix}`, {
      cause,
    });
  }
}

function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === "string" && stderr.trim() !== ""
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().split("\n")[0] ?? "";
}

// Asks the daemon, not the path: a `docker` with no daemon behind it cannot start
// the origin either.
export async function dockerUnavailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
      env,
      timeout: 15_000,
    });
    return undefined;
  } catch (error) {
    return `Docker is not available — ${firstLine(error)}; the origin harness needs a Docker daemon it can start the S3 origin on — start a Docker daemon, or point DOCKER_HOST at one`;
  }
}

export async function opensslUnavailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    await execFileAsync("openssl", ["version"], { env, timeout: 15_000 });
    return undefined;
  } catch (error) {
    return `openssl is not available — ${firstLine(error)}; the origin harness mints the run's TLS certificate with it — install openssl, or put it on PATH`;
  }
}

export function caTrustUnavailable(api: Partial<typeof tls> = tls): string | undefined {
  if (
    typeof api.setDefaultCACertificates === "function" &&
    typeof api.getCACertificates === "function"
  ) {
    return undefined;
  }
  return `Node ${process.version} cannot extend the default CA list (tls.setDefaultCACertificates) — the origin harness trusts the run's certificate that way; run it on Node 24.5 or later`;
}

export interface S3Origin extends S3Access {
  // For a spawned process, which `setDefaultCACertificates` here does not reach.
  caFile: string;
  container: string;
  network: string;
  stop(): Promise<void>;
}

// Trusts the certificate process-wide until `stop`: shipped code makes the fetches,
// and `NODE_EXTRA_CA_CERTS` is read only at process start.
export async function startS3Origin(): Promise<S3Origin> {
  const teardown: (() => Promise<unknown>)[] = [];
  const stop = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const step of teardown.reverse()) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    teardown.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Origin harness: ${String(failures.length)} teardown step${failures.length === 1 ? "" : "s"} failed — find what is left with docker ps -a --filter label=${HARNESS_LABEL} and docker network ls --filter label=${HARNESS_LABEL}`,
      );
    }
  };

  try {
    const suffix = randomBytes(4).toString("hex");
    const container = `pagedeck-origin-harness-${suffix}`;
    const network = `pagedeck-origin-harness-${suffix}`;
    const accessKey = `pagedeck${randomBytes(8).toString("hex")}`;
    const secretKey = randomBytes(24).toString("hex");
    const endpoint = `https://${ORIGIN_IP}:${String(ORIGIN_PORT)}`;

    const dir = await mkdtemp(join(tmpdir(), "pagedeck-origin-harness-"));
    teardown.push(() => rm(dir, { recursive: true, force: true }));
    const certs = join(dir, "certs");
    await mkdir(certs);
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
      "-keyout", join(certs, "private.key"),
      "-out", join(certs, "public.crt"),
      "-subj", `/CN=${ORIGIN_IP}`,
      "-addext", `subjectAltName=IP:${ORIGIN_IP}`,
    ]);
    // The image runs as an unprivileged user and `docker cp` keeps openssl's 0600, so
    // the run's throwaway key is made world-readable.
    await chmod(join(certs, "private.key"), 0o644);
    const caFile = join(certs, "public.crt");
    const ca = await readFile(caFile, "utf8");

    await docker([
      "network", "create", "--internal", "--label", HARNESS_LABEL, "--subnet", ORIGIN_SUBNET, network,
    ]);
    teardown.push(() => docker(["network", "rm", network]));

    await docker(
      [
        "create", "--name", container, "--label", HARNESS_LABEL,
        "--network", network, "--ip", ORIGIN_IP,
        // Named without a value, so the credential is read from the environment and never
        // reaches an argv.
        "-e", "AWS_ACCESS_KEY_ID", "-e", "AWS_SECRET_ACCESS_KEY",
        ORIGIN_IMAGE, "server", "-master.telemetry=false",
        "-s3", `-s3.port=${String(ORIGIN_PORT)}`,
        "-s3.cert.file=/certs/public.crt", "-s3.key.file=/certs/private.key",
      ],
      { ...process.env, AWS_ACCESS_KEY_ID: accessKey, AWS_SECRET_ACCESS_KEY: secretKey },
    );
    // `--volumes` takes the image's anonymous `/data` volume with the container.
    teardown.push(() => docker(["rm", "--force", "--volumes", container]));
    await docker(["cp", `${certs}/.`, `${container}:/certs`]);
    await docker(["start", container]);

    const defaults = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaults, ca]);
    teardown.push(async () => {
      tls.setDefaultCACertificates(defaults);
    });

    await waitUntilReady(endpoint, container, [accessKey, secretKey]);
    return { endpoint, accessKey, secretKey, caFile, container, network, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// The log tail is redacted: SeaweedFS logs the access key it was given.
async function waitUntilReady(
  endpoint: string,
  container: string,
  secrets: readonly string[],
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const logs = await execFileAsync("docker", ["logs", "--tail", "20", container], {
    timeout: 15_000,
  })
    .then(({ stdout, stderr }) => `${stdout}${stderr}`)
    .catch(() => "");
  const redacted = secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), logs);
  throw new Error(
    `Origin harness: the S3 origin at ${endpoint} did not answer within ${String(READY_TIMEOUT_MS / 1000)} s (last error: ${firstLine(last)}) — run the harness on a host that routes to a Docker bridge network, as Linux does and Docker Desktop does not, or read the container's log below for why the origin did not start:\n${redacted}`,
    { cause: last },
  );
}
