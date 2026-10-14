import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { budgetReportPath, RETENTION_DIR } from "@pagedeck/core";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..");
const OUT = join(SITE, "site");
const BIN = join(SITE, "..", "core", "dist", "bin.js");
const WRANGLER = join(SITE, "node_modules", ".bin", "wrangler");

// Spelled again rather than imported, so a limit raised in the config fails here.
const LIMITS = { "/": "0b", "/signup/": "63kb" };

// Every emitted `js` byte, Brotli, each file on its own: no budget row charges a lazy chunk.
const BUILD_CEILING = 64 * 1024;

// A string only the app holds: found in `site/`, it means an island shipped server code.
const SERVER_ONLY = "Enter an email address.";

let wrangler: ChildProcess | undefined;
let origin: string;

function clean(): void {
  for (const path of [OUT, join(SITE, "content.db"), join(SITE, RETENTION_DIR), join(SITE, ".wrangler")]) {
    rmSync(path, { recursive: true, force: true });
  }
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

async function serve(): Promise<string> {
  const port = await freePort();
  const child = spawn(WRANGLER, ["dev", "--ip", "127.0.0.1", "--port", String(port)], {
    cwd: SITE,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  wrangler = child;
  let log = "";
  child.stdout?.on("data", (data: Buffer) => (log += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (log += data.toString()));
  const url = `http://127.0.0.1:${String(port)}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    try {
      await fetch(url);
      return url;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`wrangler dev did not answer on ${url}:\n${log}`);
}

function signup(body: unknown): Promise<Response> {
  return fetch(`${origin}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  clean();
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });
  origin = await serve();
}, 180_000);

afterAll(() => {
  wrangler?.kill();
  clean();
});

test("each page keeps its measured budget", () => {
  const { pages } = JSON.parse(readFileSync(budgetReportPath(SITE), "utf8")) as {
    pages: { path: string; limitText: string; actual: number }[];
  };
  expect(Object.fromEntries(pages.map((row) => [row.path, row.limitText]))).toEqual(LIMITS);
  expect(pages.find((row) => row.path === "/")?.actual).toBe(0);
});

test("the whole build's JavaScript stays under its ceiling", () => {
  const assets = join(OUT, "assets");
  const total = readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .reduce((sum, name) => sum + brotliCompressSync(readFileSync(join(assets, name))).length, 0);
  expect(total).toBeLessThanOrEqual(BUILD_CEILING);
});

test("no emitted file carries the app's code", () => {
  const leaked = readdirSync(OUT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file, "utf8").includes(SERVER_ONLY));
  expect(leaked).toEqual([]);
});

test("the build routes the prefix for Cloudflare Pages, and the upload leaves that file out", () => {
  expect(JSON.parse(readFileSync(join(OUT, "_routes.json"), "utf8"))).toEqual({
    version: 1,
    include: ["/api", "/api/*"],
    exclude: [],
  });
  expect(readFileSync(join(OUT, ".assetsignore"), "utf8").split("\n")).toEqual(
    expect.arrayContaining(["/manifest.json", "/.pagedeck", "/404.html", "/_routes.json"]),
  );
});

test("a built page is served from site/ with the build's headers", async () => {
  for (const path of ["/", "/signup/"]) {
    const response = await fetch(`${origin}${path}`);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("Content-Type"), path).toMatch(/^text\/html/);
    expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
    expect(response.headers.get("Cache-Control"), path).not.toBe("no-store");
  }
}, 30_000);

test("the prefix is answered by the app, with the app's own headers", async () => {
  const accepted = await signup({ email: "reader@example.com" });
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toEqual({ message: "Thanks. We will write to reader@example.com." });
  expect(accepted.headers.get("Cache-Control")).toBe("no-store");
  // `secureHeaders()`'s value, not the build's `DENY`: `_headers` never reaches the app.
  expect(accepted.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");

  const refused = await signup({ email: "" });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: SERVER_ONLY });
}, 30_000);

test("a path with no file falls through to the app's 404", async () => {
  const response = await fetch(`${origin}/no-such-page/`);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}, 30_000);
