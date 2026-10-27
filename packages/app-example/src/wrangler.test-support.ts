import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { RETENTION_DIR } from "@pagedeck/core";

const execFileAsync = promisify(execFile);

export const SITE = join(import.meta.dirname, "..");
export const OUT = join(SITE, "site");
export const BIN = join(SITE, "..", "core", "dist", "bin.js");
export const WRANGLER = join(SITE, "node_modules", ".bin", "wrangler");
export const DEV_VARS = join(SITE, ".dev.vars");

export function clean(): void {
  const paths = [OUT, join(SITE, "content.db"), join(SITE, RETENTION_DIR), join(SITE, ".wrangler"), DEV_VARS];
  for (const path of paths) {
    rmSync(path, { recursive: true, force: true });
  }
}

export async function build(): Promise<void> {
  clean();
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(
              new Error(
                `App example: a listener on 127.0.0.1 port 0 reported ${JSON.stringify(address)} instead of a TCP address, so there is no free port to start wrangler dev on — check that this host allows a TCP listener on 127.0.0.1, then run the test again`,
              ),
            ),
      );
    });
  });
}

export interface Served {
  readonly origin: string;
  readonly child: ChildProcess;
  readonly log: () => string;
}

/**
 * `wrangler dev` over `site/` and the app, on one origin, as the README runs it. In a
 * release directory, `args` names its bundle: `["worker/app.js", "--no-bundle"]`.
 */
export async function serve(cwd = SITE, args: readonly string[] = []): Promise<Served> {
  const port = await freePort();
  const child = spawn(WRANGLER, ["dev", ...args, "--ip", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (data: Buffer) => (log += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (log += data.toString()));
  const origin = `http://127.0.0.1:${String(port)}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    try {
      await fetch(origin);
      return { origin, child, log: () => log };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  child.kill();
  throw new Error(`wrangler dev did not answer on ${origin}:\n${log}`);
}

/** Kills `wrangler dev` and waits for it, so nothing still holds `site/` when it is removed. */
export async function stop(served: Served | undefined): Promise<void> {
  const child = served?.child;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}
