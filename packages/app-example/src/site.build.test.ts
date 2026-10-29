import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { budgetReportPath } from "@pagedeck/core";
import { CONTENT_SECURITY_POLICY } from "./csp.js";
import { cookieOf as cookieIn, tokenOf } from "./cookie.test-support.js";
import { build, clean, DEV_VARS, OUT, serve, SITE, stop, WRANGLER, wranglerEnv } from "./wrangler.test-support.js";
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

// Written to `.dev.vars` at test time, so only the running Worker ever holds it.
const ACCOUNT = { email: "editor@example.com", password: `password-${randomUUID()}` };

const run = promisify(execFile);

let wrangler: Served | undefined;
let origin: string;
const issued: string[] = [];

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
  writeFileSync(DEV_VARS, `ACCOUNT_EMAIL=${ACCOUNT.email}\nACCOUNT_PASSWORD=${ACCOUNT.password}\n`);
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

function scriptSources(policy: string): readonly string[] {
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name === "script-src") return sources;
  }
  return [];
}

test("every page's inline scripts are in the policy, and the policy lists no other", () => {
  const { pages } = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")) as {
    pages: { path: string; inlineScriptHashes?: string[] }[];
  };
  const allowed = scriptSources(CONTENT_SECURITY_POLICY);
  const carried = new Set<string>();
  for (const page of pages) {
    for (const hash of page.inlineScriptHashes ?? []) {
      expect(allowed, `${page.path} carries ${hash}`).toContain(hash);
      carried.add(hash);
    }
  }
  expect(new Set(allowed.filter((source) => source.startsWith("'sha256-")))).toEqual(carried);
});

test("the build routes the prefixes for Cloudflare Pages, and the upload leaves that file out", () => {
  expect(JSON.parse(readFileSync(join(OUT, "_routes.json"), "utf8"))).toEqual({
    version: 1,
    include: ["/account", "/account/*", "/api", "/api/*"],
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
    expect(response.headers.get("Content-Security-Policy"), path).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("Cache-Control") ?? "", path).not.toMatch(/private|no-store/);
    expect(response.headers.get("Set-Cookie"), path).toBeNull();
  }
}, 30_000);

test("the prefix is answered by the app, with the app's own headers", async () => {
  const accepted = await signup("reader@example.com");
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toEqual({ message: "Thanks. We will write to reader@example.com." });
  expect(accepted.headers.get("Cache-Control")).toBe("private, no-store");
  // `secureHeaders()`'s value, not the build's `DENY`: `_headers` never reaches the app.
  expect(accepted.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(accepted.headers.get("Strict-Transport-Security")).toBeNull();

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
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Strict-Transport-Security")).toBeNull();
}, 30_000);

async function signIn(at: string, password = ACCOUNT.password, from = at): Promise<Response> {
  const response = await fetch(`${at}/account/sign-in`, {
    method: "POST",
    headers: { Origin: from },
    body: new URLSearchParams({ email: ACCOUNT.email, password }),
  });
  for (const cookie of response.headers.getSetCookie()) issued.push(cookie);
  return response;
}

function cookieOf(response: Response): string {
  return cookieIn(response.headers.getSetCookie()[0] ?? "");
}

function me(at: string, cookie?: string): Promise<Response> {
  return fetch(`${at}/account/me`, cookie === undefined ? {} : { headers: { Cookie: cookie } });
}

function signOut(at: string, cookie: string, from = at): Promise<Response> {
  return fetch(`${at}/account/sign-out`, { method: "POST", headers: { Origin: from, Cookie: cookie } });
}

test("an anonymous request for the account is refused, and nothing may cache the answer", async () => {
  const response = await me(origin);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Sign in to see your account." });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(response.headers.get("Content-Security-Policy")).toBeNull();
  expect(response.headers.get("Strict-Transport-Security")).toBeNull();
}, 30_000);

test("sign-in opens the account, and sign-out revokes the same cookie on the server", async () => {
  expect((await signIn(origin, "not the password")).status).toBe(401);

  const signedIn = await signIn(origin);
  expect(signedIn.status).toBe(200);
  expect(signedIn.headers.get("Set-Cookie")).toMatch(
    /^__Host-session=[\w-]{43}; Max-Age=3600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
  );
  const cookie = cookieOf(signedIn);

  const authorized = await me(origin, cookie);
  expect(authorized.status).toBe(200);
  expect(await authorized.json()).toEqual({ email: ACCOUNT.email });
  expect(authorized.headers.get("Cache-Control")).toBe("private, no-store");

  const signedOut = await signOut(origin, cookie);
  expect(signedOut.status).toBe(204);
  expect(signedOut.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await me(origin, cookie)).status).toBe(401);
}, 30_000);

test("a sign-in posted from another site is refused, and sets no cookie", async () => {
  const response = await signIn(origin, ACCOUNT.password, "https://elsewhere.example");
  expect(response.status).toBe(403);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}, 30_000);

test("a sign-out posted from another site is refused, and the session still holds", async () => {
  const cookie = cookieOf(await signIn(origin));
  const response = await signOut(origin, cookie, "https://elsewhere.example");
  expect(response.status).toBe(403);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await me(origin, cookie)).status).toBe(200);
}, 30_000);

test("an anonymous request for another path under the account gets no account", async () => {
  for (const path of ["/account", "/account/", "/account/me/"]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    expect(response.status, path).toBe(404);
    expect(await response.text(), path).not.toContain(ACCOUNT.email);
    expect(response.headers.get("Cache-Control"), path).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie"), path).toBeNull();
  }
}, 30_000);

test("a session past its lifetime is refused", async () => {
  const SESSION_SECONDS = 3;
  const state = mkdtempSync(join(tmpdir(), "pagedeck-app-example-sessions-"));
  const short = await serve(SITE, ["--var", `SESSION_SECONDS:${String(SESSION_SECONDS)}`, "--persist-to", state]);
  try {
    const signedAt = Date.now();
    const signedIn = await signIn(short.origin);
    expect(signedIn.status).toBe(200);
    const cookie = cookieOf(signedIn);
    expect((await me(short.origin, cookie)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, signedAt + SESSION_SECONDS * 1000 + 500 - Date.now()));
    const expired = await me(short.origin, cookie);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("Cache-Control")).toBe("private, no-store");
  } finally {
    await stop(short);
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);

test("neither site/, the app's bundle nor wrangler's log holds the credential or a session", async () => {
  const tokens = issued.map(tokenOf).filter(Boolean);
  expect(tokens.length).toBeGreaterThan(0);
  const secrets = [ACCOUNT.password, ...tokens];

  const bundle = mkdtempSync(join(tmpdir(), "pagedeck-app-example-bundle-"));
  try {
    await run(WRANGLER, ["deploy", "--dry-run", "--outdir", bundle], {
      cwd: SITE,
      env: wranglerEnv(),
    });
    const files = [OUT, bundle].flatMap((root) =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name)),
    );
    expect(files.some((file) => file.startsWith(bundle) && file.endsWith(".js"))).toBe(true);
    const leaks = files.flatMap((file) => {
      const text = readFileSync(file, "latin1");
      return secrets.filter((secret) => text.includes(secret)).map(() => file);
    });
    const log = wrangler?.log() ?? "";
    expect(log).toContain("ACCOUNT_PASSWORD");
    expect({ leaks, inLog: secrets.filter((secret) => log.includes(secret)).length }).toEqual({ leaks: [], inLog: 0 });
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
}, 120_000);

test("the preview deployment is a Worker with no code, served on one host and no workers.dev or preview URL", async () => {
  const config = JSON.parse(readFileSync(join(SITE, "wrangler.preview.jsonc"), "utf8")) as Record<string, unknown>;
  expect(config).toMatchObject({ workers_dev: false, preview_urls: false });
  expect(config["main"]).toBeUndefined();
  expect(config["routes"]).toEqual([{ pattern: expect.any(String) as string, custom_domain: true }]);

  const outdir = mkdtempSync(join(tmpdir(), "pagedeck-app-example-preview-"));
  try {
    const { stdout, stderr } = await run(
      WRANGLER,
      ["deploy", "--dry-run", "--config", "wrangler.preview.jsonc", "--outdir", outdir],
      { cwd: SITE, env: wranglerEnv() },
    );
    expect(`${stdout}${stderr}`).toContain("--dry-run: exiting now.");
    expect(`${stdout}${stderr}`).not.toMatch(/Unexpected fields|WARNING/);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}, 120_000);
