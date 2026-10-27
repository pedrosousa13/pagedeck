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
const BIN = join(SITE, "..", "core", "dist", "bin.js");
const WRANGLER = join(SITE, "node_modules", ".bin", "wrangler");

export function clean(): void {
  for (const path of [OUT, join(SITE, "content.db"), join(SITE, RETENTION_DIR), join(SITE, ".wrangler")]) {
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
          : reject(new Error("no port")),
      );
    });
  });
}

export interface Served {
  readonly origin: string;
  readonly child: ChildProcess;
}

/** `wrangler dev` over `site/` and the app, on one origin, as the README runs it. */
export async function serve(): Promise<Served> {
  const port = await freePort();
  const child = spawn(WRANGLER, ["dev", "--ip", "127.0.0.1", "--port", String(port)], {
    cwd: SITE,
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
      return { origin, child };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  child.kill();
  throw new Error(`wrangler dev did not answer on ${origin}:\n${log}`);
}
