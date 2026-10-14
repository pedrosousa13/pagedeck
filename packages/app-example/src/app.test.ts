import { expect, test } from "vitest";
import app from "./app.js";

function signup(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("a valid address is accepted", async () => {
  const response = await signup({ email: "reader@example.com" });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    message: "Thanks. We will write to reader@example.com.",
  });
});

test("anything else is refused with the reason", async () => {
  for (const body of [{}, { email: "" }, { email: "no-at-sign" }, { email: 42 }]) {
    const response = await signup(body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter an email address." });
  }
});

// The host's `_headers` rules never reach a response the Worker writes, so the app sets its own.
test("every response carries the app's own headers, a refusal included", async () => {
  for (const response of [
    await signup({ email: "reader@example.com" }),
    await signup({}),
    await app.request("/api/nope"),
  ]) {
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  }
});

test("only the signup route answers", async () => {
  expect((await app.request("/api/signup")).status).toBe(404);
  expect((await app.request("/signup", { method: "POST" })).status).toBe(404);
});
