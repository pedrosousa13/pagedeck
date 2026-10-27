import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

export interface SessionStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AccountEnv {
  SESSIONS: SessionStore;
  ACCOUNT_EMAIL?: string | undefined;
  ACCOUNT_PASSWORD?: string | undefined;
  SESSION_SECONDS?: string | undefined;
}

interface Session {
  readonly email: string;
  readonly expiresAt: number;
}

const COOKIE = "session";
const COOKIE_OPTIONS = { prefix: "host", path: "/", secure: true } as const;

// KV refuses an `expirationTtl` under 60 seconds, so a shorter lifetime is the app's own check.
const KV_MINIMUM_TTL = 60;

function lifetime(env: AccountEnv): number {
  const value = env.SESSION_SECONDS ?? "3600";
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `App example: SESSION_SECONDS is "${value}", not a whole number of seconds above 0. Set it to one, such as 3600, or remove it for an hour.`,
    );
  }
  return Number(value);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// The store is keyed by the token's digest, so whoever can read the store cannot sign in with it.
async function keyOf(token: string): Promise<string> {
  return `session:${Array.from(await sha256(token), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function checkCredential(env: AccountEnv, email: string, password: string): Promise<string | undefined> {
  if (!env.ACCOUNT_EMAIL || !env.ACCOUNT_PASSWORD) return undefined;
  const [given, expected] = await Promise.all([
    sha256(`${email}\n${password}`),
    sha256(`${env.ACCOUNT_EMAIL}\n${env.ACCOUNT_PASSWORD}`),
  ]);
  let difference = 0;
  given.forEach((byte, at) => (difference |= byte ^ (expected[at] as number)));
  return difference === 0 ? env.ACCOUNT_EMAIL : undefined;
}

async function cookieKeyOf(c: Context<{ Bindings: AccountEnv }>): Promise<string | undefined> {
  const token = getCookie(c, COOKIE, "host");
  return token === undefined ? undefined : keyOf(token);
}

async function sessionOf(c: Context<{ Bindings: AccountEnv }>): Promise<Session | undefined> {
  const key = await cookieKeyOf(c);
  if (key === undefined) return undefined;
  const stored = await c.env.SESSIONS.get(key);
  if (stored === null) return undefined;
  const session = JSON.parse(stored) as Session;
  if (Date.now() < session.expiresAt) return session;
  await c.env.SESSIONS.delete(key);
  return undefined;
}

const account = new Hono<{ Bindings: AccountEnv }>()
  .onError((error, c) =>
    c.json({ error: "Something went wrong. Try again." }, error instanceof HTTPException ? error.status : 500),
  )
  .use(csrf())
  .post(
    "/sign-in",
    validator("form", (value: { email?: unknown; password?: unknown }) => ({
      email: typeof value.email === "string" ? value.email : "",
      password: typeof value.password === "string" ? value.password : "",
    })),
    async (c) => {
      const { email, password } = c.req.valid("form");
      const signedIn = await checkCredential(c.env, email, password);
      if (signedIn === undefined) return c.json({ error: "The email or password is wrong." }, 401);
      const seconds = lifetime(c.env);
      const previous = await cookieKeyOf(c);
      if (previous !== undefined) await c.env.SESSIONS.delete(previous);
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const session: Session = { email: signedIn, expiresAt: Date.now() + seconds * 1000 };
      await c.env.SESSIONS.put(await keyOf(token), JSON.stringify(session), {
        expirationTtl: Math.max(seconds, KV_MINIMUM_TTL),
      });
      setCookie(c, COOKIE, token, { ...COOKIE_OPTIONS, httpOnly: true, sameSite: "Lax", maxAge: seconds });
      return c.json({ email: signedIn }, 200);
    },
  )
  .get("/me", async (c) => {
    const session = await sessionOf(c);
    if (session === undefined) {
      deleteCookie(c, COOKIE, COOKIE_OPTIONS);
      return c.json({ error: "Sign in to see your account." }, 401);
    }
    return c.json({ email: session.email }, 200);
  })
  .post("/sign-out", async (c) => {
    const key = await cookieKeyOf(c);
    if (key !== undefined) await c.env.SESSIONS.delete(key);
    deleteCookie(c, COOKIE, COOKIE_OPTIONS);
    return c.body(null, 204);
  });

export default account;
