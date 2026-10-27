import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { budgetReportPath } from "@pagedeck/core";
import { build, clean, OUT, serve, SITE, stop } from "./wrangler.test-support.js";
import type { Served } from "./wrangler.test-support.js";

// Spelled again rather than imported, so a limit raised in the config fails here.
const LIMITS = {
  "/": "0b",
  "/signup/": "63kb",
  "/signup/thanks/": "0b",
  "/signup/invalid/": "0b",
  "/signup/failed/": "0b",
};

// Every emitted `js` byte, Brotli, each file on its own: no budget row charges a lazy chunk.
const BUILD_CEILING = 64 * 1024;

// A string only the app holds: found in `site/`, it means an island shipped server code.
const SERVER_ONLY = "Enter an email address.";

let wrangler: Served | undefined;
let origin: string;

function signup(email: string, accept = "application/json"): Promise<Response> {
  return fetch(`${origin}/api/signup`, {
    method: "POST",
    headers: { Origin: origin, Accept: accept },
    body: new URLSearchParams({ email }),
    redirect: "manual",
  });
}

beforeAll(async () => {
  await build();
  wrangler = await serve();
  origin = wrangler.origin;
}, 180_000);

afterAll(async () => {
  await stop(wrangler);
  clean();
});

test("each page keeps its measured budget", () => {
  const { pages } = JSON.parse(readFileSync(budgetReportPath(SITE), "utf8")) as {
    pages: { path: string; limitText: string; actual: number }[];
  };
  expect(Object.fromEntries(pages.map((row) => [row.path, row.limitText]))).toEqual(LIMITS);
  for (const path of ["/", "/signup/thanks/", "/signup/invalid/", "/signup/failed/"]) {
    expect(pages.find((row) => row.path === path)?.actual, path).toBe(0);
  }
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
  for (const path of Object.keys(LIMITS)) {
    const response = await fetch(`${origin}${path}`);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("Content-Type"), path).toMatch(/^text\/html/);
    expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
    expect(response.headers.get("Cache-Control"), path).not.toBe("no-store");
  }
}, 30_000);

test("the prefix is answered by the app, with the app's own headers", async () => {
  const accepted = await signup("reader@example.com");
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toEqual({ message: "Thanks. We will write to reader@example.com." });
  expect(accepted.headers.get("Cache-Control")).toBe("no-store");
  // `secureHeaders()`'s value, not the build's `DENY`: `_headers` never reaches the app.
  expect(accepted.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");

  const refused = await signup("reader@localhost");
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: SERVER_ONLY });
}, 30_000);

test("a form posted without JavaScript lands on a page that holds no address", async () => {
  const html = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  for (const [email, page] of [
    ["reader@example.com", "/signup/thanks/"],
    ["reader@localhost", "/signup/invalid/"],
  ] as const) {
    const response = await signup(email, html);
    expect(response.status, email).toBe(303);
    expect(response.headers.get("Location"), email).toBe(page);
    expect((await fetch(`${origin}${page}`)).status, page).toBe(200);
  }
}, 30_000);

test("a form posted from another site is refused, and the navigation lands on a page", async () => {
  const response = await fetch(`${origin}/api/signup`, {
    method: "POST",
    headers: { Origin: "https://elsewhere.example" },
    body: new URLSearchParams({ email: "reader@example.com" }),
    redirect: "manual",
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/signup/failed/");
  expect((await fetch(`${origin}/signup/failed/`)).status).toBe(200);
}, 30_000);

test("a path with no file falls through to the app's 404", async () => {
  const response = await fetch(`${origin}/no-such-page/`);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}, 30_000);
