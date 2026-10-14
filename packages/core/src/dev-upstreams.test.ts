import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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
const startup: string[] = [];
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

const APP_MARKER = "app-secret-2d90";
const IMPORT_FIX =
  'import only the app\'s types, with "import type", or move the code both need out of the app\'s source';

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "src"), { recursive: true });
  mkdirSync(join(SITE, "app"), { recursive: true });
  mkdirSync(join(SITE, "content", "en"), { recursive: true });
  writeFileSync(
    join(SITE, "src", "Prose.js"),
    `export default function Prose() { return "prose-6c1d"; }\n`,
  );
  writeFileSync(
    join(SITE, "app", "index.ts"),
    `export const SECRET = ${JSON.stringify(APP_MARKER)};\nexport type Answer = { ok: true };\n`,
  );
  writeFileSync(
    join(SITE, "src", "cart.js"),
    `import { SECRET } from "../app/index.ts";\nexport const cart = () => SECRET;\n`,
  );
  writeFileSync(
    join(SITE, "src", "typed.ts"),
    `import type { Answer } from "../app/index.ts";\nconst ok: Answer["ok"] = true;\nexport const typed = () => "typed-81c3 " + String(ok);\n`,
  );
  writeFileSync(
    join(SITE, "src", "Server.js"),
    `import { SECRET } from "../app/index.ts";\nexport default function Server() { return "server " + SECRET; }\n`,
  );
  for (const path of ["home", "server"]) {
    writeFileSync(
      join(SITE, "content", "en", `${path}.json`),
      `${JSON.stringify({ rev: 1, data: { title: path } })}\n`,
    );
  }
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
    components: {
      prose: "./src/Prose.js",
      server: "./src/Server.js",
    },
    content: (page) => ({
      tree: page.path === "/server" ? [{ component: "server" }] : [{ component: "prose" }],
    }),
    routing: {
      upstreams: [
        { prefix: "/api/", dev: ${JSON.stringify(appUrl)}, source: "app/" },
        { prefix: "/down/", dev: ${JSON.stringify(downUrl)} },
        { prefix: "/bare/" },
        { prefix: "/gone/", source: "nowhere/" },
      ],
    },
  },
});
`,
  );
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Echoes each text frame; every frame the tests send fits one read. */
function echoSocket(request: IncomingMessage, socket: Socket): void {
  const key = request.headers["sec-websocket-key"] ?? "";
  const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", (frame: Buffer) => {
    if (((frame[0] as number) & 0x0f) === 0x8) {
      socket.end();
      return;
    }
    const length = (frame[1] as number) & 0x7f;
    const mask = frame.subarray(2, 6);
    const payload = Buffer.from(
      frame.subarray(6, 6 + length).map((byte, at) => byte ^ (mask[at % 4] as number)),
    );
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  socket.on("error", () => socket.destroy());
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
      if (request.url === "/api/hop") {
        response.writeHead(200, {
          connection: "x-hop",
          "x-hop": "hop-7d12",
          "keep-alive": "timeout=99",
          "proxy-authenticate": "Basic",
          "x-end": "end-4b6e",
          "set-cookie": ["c=3", "d=4"],
        });
        response.end("hop");
        return;
      }
      response.writeHead(201, {
        "content-type": "application/json",
        "x-app": "answered-3f8a",
        "set-cookie": ["a=1", "b=2"],
      });
      response.end(JSON.stringify({ answered: request.url }));
    });
  });
  app.on("upgrade", echoSocket);
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
  startup.push(...lines.splice(0));
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

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function rawRequest(
  path: string,
  headers: Record<string, string>,
): Promise<Answer> {
  return await new Promise<Answer>((resolve, reject) => {
    const request = httpRequest(`${dev.url}${path}`, { headers }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        resolve({
          status: answer.statusCode ?? 0,
          headers: answer.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("upgrade", (answer, socket) => {
      socket.destroy();
      reject(new Error(`the upgrade was answered ${String(answer.statusCode)}`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function firstMessage(socket: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
    socket.addEventListener("error", () => reject(new Error(`no message on ${socket.url}`)));
  });
}

async function opened(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`${socket.url} did not open`)));
  });
}

test("hop-by-hop headers are dropped both ways, with each header a Connection header names, and end-to-end headers are kept", async () => {
  received.length = 0;
  const answer = await rawRequest("/api/hop", {
    connection: "keep-alive, x-secret",
    "x-secret": "secret-0e44",
    "keep-alive": "timeout=7",
    "proxy-authorization": "Basic eDp5",
    "proxy-connection": "keep-alive",
    te: "trailers",
    "x-kept": "kept-2b19",
  });

  expect(answer.status).toBe(200);
  const [seen] = received as [Received];
  expect(seen.headers["x-secret"]).toBeUndefined();
  expect(seen.headers.connection ?? "").not.toContain("x-secret");
  expect(seen.headers["keep-alive"]).toBeUndefined();
  expect(seen.headers["proxy-authorization"]).toBeUndefined();
  expect(seen.headers["proxy-connection"]).toBeUndefined();
  expect(seen.headers.te).toBeUndefined();
  expect(seen.headers["x-kept"]).toBe("kept-2b19");

  expect(answer.headers["x-hop"]).toBeUndefined();
  expect(answer.headers.connection ?? "").not.toContain("x-hop");
  expect(answer.headers["keep-alive"]).not.toBe("timeout=99");
  expect(answer.headers["proxy-authenticate"]).toBeUndefined();
  expect(answer.headers["x-end"]).toBe("end-4b6e");
  expect(answer.headers["set-cookie"]).toEqual(["c=3", "d=4"]);
  expect(answer.body).toBe("hop");
}, REQUEST_TIMEOUT);

test("the client's address is appended to an incoming X-Forwarded-For chain", async () => {
  received.length = 0;
  await rawRequest("/api/chain", { "x-forwarded-for": "203.0.113.7, 198.51.100.2" });
  await rawRequest("/api/chain", {});

  expect(received.map((seen) => seen.headers["x-forwarded-for"])).toEqual([
    "203.0.113.7, 198.51.100.2, 127.0.0.1",
    "127.0.0.1",
  ]);
  expect(received[0]?.headers.forwarded).toBeUndefined();
}, REQUEST_TIMEOUT);

test("a WebSocket under an upstream prefix round-trips through the app, while Vite's HMR socket still connects", async () => {
  const ws = dev.url.replace("http", "ws");
  const hmr = new WebSocket(`${ws}/`, ["vite-hmr"]);
  const echo = new WebSocket(`${ws}/api/socket?room=1`);
  try {
    const connected = firstMessage(hmr);
    await opened(echo);
    const echoed = firstMessage(echo);
    echo.send("echo-5e2a");
    expect(await echoed).toBe("echo-5e2a");
    expect(JSON.parse(await connected)).toMatchObject({ type: "connected" });
  } finally {
    hmr.close();
    echo.close();
  }
}, REQUEST_TIMEOUT);

test("an upgrade an app does not answer is a 502 with the HTTP path's message, on the run's channel too", async () => {
  lines.length = 0;
  const answer = await rawRequest("/down/socket", {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  });
  const shown = `${downUrl}/`;
  const message = `Dev server: build.routing.upstreams[1] forwards "/down/" to "${shown}", which did not answer "/down/socket" (ECONNREFUSED) — start the app at "${shown}" first, or correct "dev" to the URL it listens on: connect ECONNREFUSED ${new URL(downUrl).host}`;

  expect(answer.status).toBe(502);
  expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(answer.body).toBe(`${message}\n`);
  expect(lines).toEqual([message]);
}, REQUEST_TIMEOUT);

test("a source not on disk is reported once at startup, the way the build refuses it", () => {
  expect(startup).toEqual([
    `Config "${join(SITE, "pagedeck.config.ts")}": "build.routing" declares 1 upstream field this build cannot route to — correct each as its own line says:\n  upstreams[3] — "source" — "nowhere/" — nothing is on disk at "${join(SITE, "nowhere")}" — write the path of the app's file or directory, relative to the site root, such as "app/"`,
  ]);
});

test("a module the browser requests that imports the app's source by value reaches the overlay and the run's channel", async () => {
  lines.length = 0;
  const hmr = new WebSocket(`${dev.url.replace("http", "ws")}/`, ["vite-hmr"]);
  try {
    expect(JSON.parse(await firstMessage(hmr))).toMatchObject({ type: "connected" });
    const overlay = firstMessage(hmr);
    const module = await fetch(`${dev.url}/src/cart.js`);
    await module.text();
    const message = [
      `Dev server: 1 import from island code reaches the source of an upstream app, so the app's code would ship to the browser — ${IMPORT_FIX}:`,
      '  "./src/cart.js" imports "../app/index.ts" — build.routing.upstreams[0] source "app/"',
    ].join("\n");

    expect(module.status).not.toBe(200);
    const sent = JSON.parse(await overlay) as { type: string; err?: { message: string } };
    expect(sent.type).toBe("error");
    expect(sent.err?.message).toBe(message);
    expect(lines).toEqual([message]);
  } finally {
    hmr.close();
  }
}, REQUEST_TIMEOUT);

test("a module the browser requests that imports only the app's types is served, and a server-rendered component may import the app", async () => {
  lines.length = 0;
  const typed = await fetch(`${dev.url}/src/typed.ts`);
  expect(typed.status).toBe(200);
  expect(await typed.text()).toContain("typed-81c3");

  const page = await fetch(`${dev.url}/server`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(`server ${APP_MARKER}`);
  expect(lines).toEqual([]);
}, REQUEST_TIMEOUT);
