import { expect, test, vi } from "vitest";
import app from "./app.js";
import type { AccountEnv, SessionStore } from "./account.js";

const ORIGIN = "https://site.test";
const EMAIL = "editor@example.com";
const PASSWORD = "a password only this test knows";

class MemoryStore implements SessionStore {
  readonly entries = new Map<string, { value: string; expirationTtl: number }>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key)?.value ?? null);
  }
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void> {
    this.entries.set(key, { value, expirationTtl: options.expirationTtl });
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

function envOf(overrides: Partial<AccountEnv> = {}): AccountEnv {
  return { SESSIONS: new MemoryStore(), ACCOUNT_EMAIL: EMAIL, ACCOUNT_PASSWORD: PASSWORD, ...overrides };
}

async function signIn(env: AccountEnv, password = PASSWORD, headers: Record<string, string> = { Origin: ORIGIN }) {
  return app.request(
    `${ORIGIN}/account/sign-in`,
    { method: "POST", headers, body: new URLSearchParams({ email: EMAIL, password }) },
    env,
  );
}

function cookieOf(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0] as string;
}

function me(env: AccountEnv, cookie?: string) {
  return app.request(`${ORIGIN}/account/me`, cookie === undefined ? {} : { headers: { Cookie: cookie } }, env);
}

function signOut(env: AccountEnv, cookie: string, headers: Record<string, string> = { Origin: ORIGIN }) {
  return app.request(`${ORIGIN}/account/sign-out`, { method: "POST", headers: { ...headers, Cookie: cookie } }, env);
}

test("an anonymous request for the account is refused", async () => {
  const response = await me(envOf());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Sign in to see your account." });
});

test("sign-in sets a __Host- session cookie that scripts and other sites cannot use", async () => {
  const response = await signIn(envOf());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ email: EMAIL });
  const cookie = response.headers.get("Set-Cookie") ?? "";
  expect(cookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43};/);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=3600"]) {
    expect(cookie.split("; "), attribute).toContain(attribute);
  }
  expect(cookie).not.toMatch(/Domain=/i);
});

test("a wrong or missing credential signs nobody in", async () => {
  for (const env of [envOf(), envOf({ ACCOUNT_PASSWORD: undefined }), envOf({ ACCOUNT_PASSWORD: "" })]) {
    const response = await signIn(env, "not the password");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "The email or password is wrong." });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  }
  const empty = envOf({ ACCOUNT_PASSWORD: "" });
  expect((await signIn(empty, "")).status).toBe(401);
});

test("a signed-in request sees the account, and the store never holds the cookie's value", async () => {
  const env = envOf();
  const cookie = cookieOf(await signIn(env));
  const response = await me(env, cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ email: EMAIL });

  const token = cookie.split("=")[1] as string;
  const stored = [...(env.SESSIONS as MemoryStore).entries].flatMap(([key, { value }]) => [key, value]).join("\n");
  expect(stored).not.toContain(token);
  expect(stored).not.toContain(PASSWORD);
});

test("sign-out revokes the session on the server, so the same cookie is refused", async () => {
  const env = envOf();
  const cookie = cookieOf(await signIn(env));
  const response = await signOut(env, cookie);
  expect(response.status).toBe(204);
  expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session=;.*Max-Age=0/);
  expect((env.SESSIONS as MemoryStore).entries.size).toBe(0);
  expect((await me(env, cookie)).status).toBe(401);
});

test("a session past its lifetime is refused and removed, whatever the store still holds", async () => {
  const env = envOf({ SESSION_SECONDS: "1" });
  const signedIn = await signIn(env);
  expect(signedIn.headers.get("Set-Cookie")).toContain("Max-Age=1");
  expect([...(env.SESSIONS as MemoryStore).entries.values()].map((entry) => entry.expirationTtl)).toEqual([60]);
  const cookie = cookieOf(signedIn);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1000 });
  const response = await Promise.resolve(me(env, cookie)).finally(() => vi.useRealTimers());
  expect(response.status).toBe(401);
  expect((env.SESSIONS as MemoryStore).entries.size).toBe(0);
});

test("a cookie the server never issued is refused", async () => {
  expect((await me(envOf(), "__Host-session=forged")).status).toBe(401);
  expect((await me(envOf(), "session=forged")).status).toBe(401);
});

test("sign-in and sign-out from another site are refused", async () => {
  const env = envOf();
  for (const headers of [
    { Origin: "https://elsewhere.example" },
    { Origin: "https://elsewhere.example", "Sec-Fetch-Site": "cross-site" },
    {},
  ] as Record<string, string>[]) {
    const response = await signIn(env, PASSWORD, headers);
    expect(response.status, JSON.stringify(headers)).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  }
  const cookie = cookieOf(await signIn(env));
  expect((await signOut(env, cookie, { Origin: "https://elsewhere.example" })).status).toBe(403);
  expect((await me(env, cookie)).status).toBe(200);
});

test("every account response forbids shared caching and carries the app's headers", async () => {
  const env = envOf();
  const cookie = cookieOf(await signIn(env));
  for (const response of [
    await me(env),
    await signIn(env),
    await signIn(env, "not the password"),
    await me(env, cookie),
    await signOut(env, cookie),
    await app.request(`${ORIGIN}/account/nope`, {}, env),
  ]) {
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  }
});

test("a lifetime that is not a whole number of seconds is an error, answered with fixed text", async () => {
  const response = await signIn(envOf({ SESSION_SECONDS: "an hour" }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Something went wrong. Try again." });
});
