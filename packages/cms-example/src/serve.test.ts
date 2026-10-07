import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const SERVE = join(import.meta.dirname, "..", "dist", "serve.js");

test("the serve script starts the CMS on 127.0.0.1 and prints the endpoint to give the config", async () => {
  const child = spawn(process.execPath, [SERVE, "0"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [chunk] = (await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`serve.js exited with ${String(code)} before printing`);
      }),
    ])) as [Buffer];
    const match = /^CMS serving at (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(chunk.toString());
    expect(match).not.toBeNull();

    const response = await fetch(new URL("pages", match?.[1]));
    expect(response.status).toBe(200);
  } finally {
    child.kill();
  }
}, 30_000);

test("a port that is not a whole number up to 65535 is refused by name, and nothing is served", async () => {
  for (const port of ["abc", "70000", "-1"]) {
    const failure = await execFileAsync(process.execPath, [SERVE, port]).then(
      () => undefined,
      (error: unknown) => error as { code: number; stderr: string },
    );

    expect(failure?.code).toBe(2);
    expect(failure?.stderr).toBe(
      `Port "${port}": is not a port number — pass a whole number from 0 to 65535, or nothing to serve on 4310\n`,
    );
  }
}, 30_000);
