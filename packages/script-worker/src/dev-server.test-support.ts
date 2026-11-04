import { spawn } from "node:child_process";

export interface RunningDev {
  readonly origin: string;
  stop(): Promise<void>;
}

export async function startDev(bin: string, cwd: string): Promise<RunningDev> {
  const child = spawn(process.execPath, [bin, "dev", "--port", "0"], { cwd });
  const stop = (): Promise<void> =>
    new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else {
        child.on("exit", () => done());
        child.kill("SIGTERM");
      }
    });
  const origin = await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const found = /at (http:\/\/[^\s]+)/.exec(out);
      if (found !== null) resolve(found[1] as string);
    });
    child.on("exit", (code) => {
      reject(
        new Error(
          `Dev server test support: pagedeck dev in "${cwd}" exited with ${String(code)} before it was listening — run pnpm build first if "${bin}" is missing; it wrote:\n${out}${err}`,
        ),
      );
    });
  });
  return { origin, stop };
}
