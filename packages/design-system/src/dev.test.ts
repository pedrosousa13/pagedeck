// Spawned: this suite has already loaded `pricing_page.js` into the worker, so an
// in-process dev server refuses to start (#187).
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

// Its own directory, so two tests never write one site.
const SITE = join(import.meta.dirname, "..", ".pagedeck-dev-test");
const SUPPORT = join(import.meta.dirname, "site.test-support.ts");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const STARTUP_TIMEOUT = 60_000;

let server: ChildProcess;
let origin: string;
// `[BABEL]` lines are dropped: a tool's remark about a vendor file, not a
// diagnostic about this site.
const diagnostics: string[] = [];

async function get(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.text() };
}

function scriptUrls(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

async function start(): Promise<string> {
  const child = spawn(process.execPath, [BIN, "dev", "--port", "0"], {
    cwd: SITE,
  });
  server = child;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line !== "" && !line.startsWith("[BABEL]")) diagnostics.push(line);
    }
  });

  return await new Promise<string>((resolve, reject) => {
    let out = "";
    const fail = (error: unknown): void => {
      child.kill("SIGKILL");
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `pagedeck dev printed no URL within ${String(STARTUP_TIMEOUT)}ms — it wrote:\n${out}\n${diagnostics.join("\n")}`,
        ),
      );
    }, STARTUP_TIMEOUT);
    child.on("error", fail);
    child.on("exit", (code) => {
      fail(
        new Error(
          `pagedeck dev exited with ${String(code)} before it was listening:\n${diagnostics.join("\n")}`,
        ),
      );
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const found = /at (http:\/\/[^\s]+)/.exec(out);
      if (found === null) return;
      clearTimeout(timer);
      resolve(found[1] as string);
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `import { testSiteConfig } from ${JSON.stringify(SUPPORT)};\nexport default testSiteConfig();\n`,
  );

  const synced = await execFileAsync(process.execPath, [BIN, "sync"], {
    cwd: SITE,
  });
  expect(synced.stdout).toContain("pages:");

  origin = await start();
  try {
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  } catch (error) {
    await stop(server);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  try {
    if (server !== undefined) await stop(server);
  } finally {
    rmSync(SITE, { recursive: true, force: true });
  }
});

test("every page serves from the store with no build step", async () => {
  const home = await get("/en");
  expect(home.status).toBe(200);
  expect(home.body).toContain("<h1>Ship the site</h1>");
  expect(home.body).toContain('<html lang="en" dir="ltr">');

  const german = await get("/de");
  expect(german.status).toBe(200);
  expect(german.body).toContain("<h1>Bau die Seite</h1>");

  const pricing = await get("/en/pricing");
  expect(pricing.status).toBe(200);
  expect(pricing.body).toContain("<h1>Plans</h1>");

  const terms = await get("/en/legal/terms");
  expect(terms.status).toBe(200);
  expect(terms.body).toContain("<h1>Terms</h1>");

  expect((await get("/en/pricing/")).body).toContain("<h1>Plans</h1>");

  expect(existsSync(join(SITE, "dist"))).toBe(false);
});

test("a zero-island page serves no client runtime beyond Vite's HMR client", async () => {
  // `/@vite/client` is the HMR plumbing criterion 4 allows a page with no island.
  const terms = await get("/en/legal/terms");
  expect(scriptUrls(terms.body)).toEqual(["/@vite/client"]);
  expect(terms.body).not.toContain("<fw-island");

  const pricing = await get("/en/pricing");
  expect(pricing.body).toContain('data-fw-component="pricing_page"');
  const scripts = scriptUrls(pricing.body);
  expect(scripts).toContain("/@vite/client");
  expect(scripts.length).toBe(2);

  const entry = scripts.find((url) => url !== "/@vite/client") as string;
  const module_ = await get(entry);
  expect(module_.status).toBe(200);
  expect(module_.body).toContain("hydrateIslands");
});

test("a path no page is routed at is refused by name", async () => {
  const missing = await get("/en/nope");
  expect(missing.status).toBe(404);
  expect(missing.body).toContain('"/en/nope"');
  expect(missing.body).toContain("pagedeck sync");
  expect(missing.body).toContain('"/en/pricing"');
});

test("the run wrote nothing to its diagnostic channel", () => {
  expect(diagnostics).toEqual([]);
});
