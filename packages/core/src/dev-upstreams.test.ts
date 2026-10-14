import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { DevServer } from "./dev.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-dev-upstreams");
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const REQUEST_TIMEOUT = 20_000;

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const received: Received[] = [];
const lines: string[] = [];
let app: Server;
let appUrl: string;
let downUrl: string;
let dev: DevServer;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "src"), { recursive: true });
  mkdirSync(join(SITE, "content", "en"), { recursive: true });
  writeFileSync(
    join(SITE, "src", "Prose.js"),
    `export default function Prose() { return "prose-6c1d"; }\n`,
  );
  writeFileSync(
    join(SITE, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 1, data: { title: "home" } })}\n`,
  );
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: (entry) => "/" + entry.path })],
    }),
    components: { prose: "./src/Prose.js" },
    content: () => ({ tree: [{ component: "prose" }] }),
    routing: {
      upstreams: [
        { prefix: "/api/", dev: ${JSON.stringify(appUrl)} },
        { prefix: "/down/", dev: ${JSON.stringify(downUrl)} },
        { prefix: "/bare/" },
      ],
    },
  },
});
`,
  );
}

beforeAll(async () => {
  app = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(201, {
        "content-type": "application/json",
        "x-app": "answered-3f8a",
        "set-cookie": ["a=1", "b=2"],
      });
      response.end(JSON.stringify({ answered: request.url }));
    });
  });
  appUrl = await listen(app);

  const gone = createServer();
  downUrl = await listen(gone);
  await close(gone);

  writeSite();
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });

  const { loadConfig } = await import("./config.js");
  const { startDevServer } = await import("./dev.js");
  dev = await startDevServer({
    config: await loadConfig(SITE),
    port: 0,
    err: (line) => lines.push(line),
  });
}, 120_000);

afterAll(async () => {
  await dev?.close();
  if (app !== undefined) await close(app);
  rmSync(SITE, { recursive: true, force: true });
}, 30_000);

test("a GET under an upstream prefix reaches the app with its full path and query, and the app's answer comes back", async () => {
  received.length = 0;
  const response = await fetch(`${dev.url}/api/items?page=2`, {
    headers: { "x-custom": "custom-9b20" },
  });

  expect(response.status).toBe(201);
  expect(response.headers.get("x-app")).toBe("answered-3f8a");
  expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  expect(await response.json()).toEqual({ answered: "/api/items?page=2" });
  expect(received).toHaveLength(1);
  const [seen] = received as [Received];
  expect(seen.method).toBe("GET");
  expect(seen.url).toBe("/api/items?page=2");
  expect(seen.headers["x-custom"]).toBe("custom-9b20");
  expect(seen.headers.host).toBe(new URL(appUrl).host);
  expect(seen.headers["x-forwarded-host"]).toBe(new URL(dev.url).host);
  expect(seen.headers["x-forwarded-proto"]).toBe("http");
}, REQUEST_TIMEOUT);

test("a POST with a JSON body under an upstream prefix reaches the app with its method and body", async () => {
  received.length = 0;
  const body = JSON.stringify({ name: "body-4d71" });
  const response = await fetch(`${dev.url}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-custom": "custom-1e55" },
    body,
  });

  expect(response.status).toBe(201);
  expect(received).toHaveLength(1);
  const [seen] = received as [Received];
  expect(seen.method).toBe("POST");
  expect(seen.url).toBe("/api/items");
  expect(seen.body).toBe(body);
  expect(seen.headers["content-type"]).toBe("application/json");
  expect(seen.headers["x-custom"]).toBe("custom-1e55");
}, REQUEST_TIMEOUT);

test("the prefix without its trailing slash is forwarded too", async () => {
  received.length = 0;
  const response = await fetch(`${dev.url}/api`);

  expect(response.status).toBe(201);
  expect(received.map((seen) => seen.url)).toEqual(["/api"]);
}, REQUEST_TIMEOUT);

test("a path outside every prefix is still served by the dev server", async () => {
  received.length = 0;
  const page = await fetch(`${dev.url}/home`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("prose-6c1d");

  const near = await fetch(`${dev.url}/apiary`);
  expect(near.status).toBe(404);
  expect(received).toEqual([]);
}, REQUEST_TIMEOUT);

test("an app that does not answer is a 502 naming the entry, the prefix, the URL, the cause and the fix, on the run's channel too", async () => {
  lines.length = 0;
  const response = await fetch(`${dev.url}/down/thing?secret=1`, {
    method: "POST",
    body: "{}",
  });
  const shown = `${downUrl}/`;
  const message = `Dev server: build.routing.upstreams[1] forwards "/down/" to "${shown}", which did not answer "/down/thing?…" (ECONNREFUSED) — start the app at "${shown}" first, or correct "dev" to the URL it listens on: connect ECONNREFUSED ${new URL(downUrl).host}`;

  expect(response.status).toBe(502);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe(`${message}\n`);
  expect(lines).toEqual([message]);
}, REQUEST_TIMEOUT);

test("an entry with no dev URL is a 502 naming the entry, the prefix and the fix, and serves no page", async () => {
  lines.length = 0;
  const response = await fetch(`${dev.url}/bare/home`);
  const message = `Dev server: build.routing.upstreams[2] declares "/bare/" with no "dev" URL, so pagedeck dev has no app to forward "/bare/home" to — set "dev" to the http or https URL the app listens on while you develop, such as "http://localhost:8787"`;

  expect(response.status).toBe(502);
  expect(await response.text()).toBe(`${message}\n`);
  expect(lines).toEqual([message]);
}, REQUEST_TIMEOUT);
