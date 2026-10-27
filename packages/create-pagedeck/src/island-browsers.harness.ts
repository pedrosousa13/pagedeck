import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { readManifest } from "@pagedeck/core";
import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "..", "core", "dist", "bin.js");
// Inside the package, so the site resolves `@pagedeck/*` and React from its node_modules (#77).
const SITE = mkdtempSync(join(PACKAGE, ".pagedeck-island-browsers-harness-"));
const OUT = join(SITE, "site");

const ENGINES: readonly BrowserType[] = [chromium, firefox, webkit];

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

let server: Server;
let origin: string;
let counterPath: string;

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`Island browsers harness: "${BIN}" is not there, so there is no pagedeck to build the starter with — run pnpm build first`);
  }
  cpSync(join(PACKAGE, "template"), SITE, { recursive: true });
  renameSync(join(SITE, "_gitignore"), join(SITE, ".gitignore"));
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });

  const manifestFile = join(OUT, "manifest.json");
  const { pages } = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  const counter = pages.find((page) => page.path.replace(/\/$/, "").endsWith("/counter"));
  if (counter === undefined) {
    throw new Error(
      `Island browsers harness: the starter's build routed ${JSON.stringify(pages.map((page) => page.path))} and no counter page — check content/counter.md is still in the template`,
    );
  }
  counterPath = counter.path;

  server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    let file = normalize(join(OUT, pathname));
    if (file.startsWith(OUT) && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(OUT) || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" }).end();
      return;
    }
    response
      .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
      .end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server?.close(done));
  rmSync(SITE, { recursive: true, force: true });
});

for (const engine of ENGINES) {
  test(`${engine.name()}: the starter's counter island hydrates, and a click updates it`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(String(error)));

      await page.goto(`${origin}${counterPath}`);
      const button = page.getByRole("button");
      await expect.poll(() => button.textContent()).toBe("Clicked 0 times");

      // React marks each node it hydrates with a `__reactFiber$…` key; a click before that is lost.
      const hydrated = (): Promise<boolean> =>
        button.evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber")));
      await expect.poll(hydrated, { timeout: 15_000 }).toBe(true);

      await button.click();
      await expect.poll(() => button.textContent()).toBe("Clicked 1 times");
      await button.click();
      await expect.poll(() => button.textContent()).toBe("Clicked 2 times");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
}
