import { expect, test } from "vitest";
import app from "./app.js";

const ORIGIN = "http://site.test";

// A browser sends `Origin` with every POST, and `Sec-Fetch-Site` beside it.
function signup(
  email: string | undefined,
  headers: Record<string, string> = { Origin: ORIGIN, Accept: "application/json" },
): Promise<Response> {
  const body = new URLSearchParams(email === undefined ? {} : { email });
  return Promise.resolve(app.request(`${ORIGIN}/api/signup`, { method: "POST", headers, body }));
}

test("a valid address is accepted", async () => {
  const response = await signup("reader@example.com");
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    message: "Thanks. We will write to reader@example.com.",
  });
});

// `reader@localhost` passes a browser's `type="email"` check; only the app's own check refuses it.
test("anything else is refused with the reason", async () => {
  for (const email of [undefined, "", "no-at-sign", "reader@localhost"]) {
    const response = await signup(email);
    expect(response.status, String(email)).toBe(422);
    expect(await response.json()).toEqual({ error: "Enter an email address." });
  }
});

test("a JSON body is refused, since the form's encoding is the one the app reads", async () => {
  const response = await app.request(`${ORIGIN}/api/signup`, {
    method: "POST",
    headers: { Origin: ORIGIN, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "reader@example.com" }),
  });
  expect(response.status).toBe(422);
});

test("a form posted without JavaScript is redirected to a page, never to a URL holding the address", async () => {
  const accepted = await signup("reader@example.com", { Origin: ORIGIN });
  expect(accepted.status).toBe(303);
  expect(accepted.headers.get("Location")).toBe("/signup/thanks/");

  const refused = await signup("reader@localhost", { Origin: ORIGIN });
  expect(refused.status).toBe(303);
  expect(refused.headers.get("Location")).toBe("/signup/invalid/");
});

test("a form posted without JavaScript that fails is redirected to a page, never shown JSON", async () => {
  for (const [label, response] of [
    ["from another site", await signup("reader@example.com", { Origin: "https://elsewhere.example" })],
    [
      "with a malformed body",
      await app.request(`${ORIGIN}/api/signup`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "multipart/form-data; boundary=x" },
        body: "not multipart",
      }),
    ],
  ] as const) {
    expect(response.status, label).toBe(303);
    expect(response.headers.get("Location"), label).toBe("/signup/failed/");
  }
});

test("a request from another site is refused", async () => {
  const crossSite: Record<string, string>[] = [
    { Origin: "https://elsewhere.example", Accept: "application/json" },
    { Origin: "https://elsewhere.example", "Sec-Fetch-Site": "cross-site", Accept: "application/json" },
    { Accept: "application/json" },
  ];
  for (const headers of crossSite) {
    const response = await signup("reader@example.com", headers);
    expect(response.status, JSON.stringify(headers)).toBe(403);
    expect(await response.json()).toEqual({ error: "Something went wrong. Try again." });
  }
});

// Behind `pagedeck dev`, the app's URL is not the page's origin, and the browser's
// `Sec-Fetch-Site` is what still says the request came from the site.
test("a same-origin fetch is accepted on Sec-Fetch-Site when Origin names another host", async () => {
  const response = await signup("reader@example.com", {
    Origin: "http://localhost:4321",
    "Sec-Fetch-Site": "same-origin",
    Accept: "application/json",
  });
  expect(response.status).toBe(201);
});

test("an error inside the app is answered with fixed text, never its own message", async () => {
  const response = await app.request(`${ORIGIN}/api/signup`, {
    method: "POST",
    headers: { Origin: ORIGIN, Accept: "application/json", "Content-Type": "multipart/form-data; boundary=x" },
    body: "not multipart",
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(JSON.stringify({ error: "Something went wrong. Try again." }));
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

// The host's `_headers` rules never reach a response the Worker writes, so the app sets its own.
test("every response carries the app's own headers, a refusal included", async () => {
  for (const response of [
    await signup("reader@example.com"),
    await signup(""),
    await signup("reader@example.com", {}),
    await app.request("/api/nope"),
  ]) {
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  }
});

test("only the signup route answers", async () => {
  expect((await app.request("/api/signup")).status).toBe(404);
  expect((await app.request("/signup", { method: "POST" })).status).toBe(404);
});

// `src/release.ts` stamps the bundle; under `wrangler dev` or a test nothing has.
test("an unstamped app names no release", async () => {
  const response = await app.request(`${ORIGIN}/api/release`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ release: null });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
