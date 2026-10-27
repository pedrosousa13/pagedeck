import { expect, test } from "vitest";
import { createWebhookReceiver, signDelivery } from "./webhook.js";

const SECRET = "a-shared-secret-of-at-least-32-bytes-0123456789";
const NOW = Date.parse("2026-10-27T09:00:00Z");
const SECONDS = Math.floor(NOW / 1000);
const BODY = JSON.stringify({ event: "page.updated", id: "faq", revision: 4 });

interface Receiver {
  receive: (request: Request) => Promise<Response>;
  dispatches: () => number;
}

function receiver(options: { maximumBodyBytes?: number; rememberedDeliveries?: number } = {}): Receiver {
  let dispatched = 0;
  const receive = createWebhookReceiver({
    secret: SECRET,
    dispatch: () => {
      dispatched += 1;
    },
    now: () => NOW,
    ...options,
  });
  return { receive, dispatches: () => dispatched };
}

async function delivery(
  init: { id?: string; timestamp?: number; body?: string; secret?: string } = {},
): Promise<Request> {
  const body = init.body ?? BODY;
  const headers = await signDelivery(init.secret ?? SECRET, {
    id: init.id ?? "delivery-1",
    timestamp: init.timestamp ?? SECONDS,
    body,
  });
  return new Request("http://127.0.0.1/webhook", { method: "POST", headers, body });
}

async function answer(response: Response): Promise<{ status: number; text: string }> {
  return { status: response.status, text: await response.text() };
}

test("a signed delivery is accepted and asks for one run", async () => {
  const { receive, dispatches } = receiver();

  const { status } = await answer(await receive(await delivery()));

  expect(status).toBe(202);
  expect(dispatches()).toBe(1);
});

test("a delivery signed with another secret, or whose body was changed after signing, is refused and asks for nothing", async () => {
  const { receive, dispatches } = receiver();
  const forged = await delivery({ secret: "another-secret-of-at-least-32-bytes-9876543210" });
  const signed = await signDelivery(SECRET, { id: "delivery-2", timestamp: SECONDS, body: BODY });
  const tampered = new Request("http://127.0.0.1/webhook", {
    method: "POST",
    headers: signed,
    body: BODY.replace("faq", "home"),
  });

  expect((await answer(await receive(forged))).status).toBe(401);
  expect((await answer(await receive(tampered))).status).toBe(401);
  expect(dispatches()).toBe(0);
});

test("a delivery whose timestamp is outside five minutes of now is refused, in the past or the future", async () => {
  const { receive, dispatches } = receiver();

  const stale = await answer(await receive(await delivery({ timestamp: SECONDS - 301 })));
  const ahead = await answer(await receive(await delivery({ id: "d-2", timestamp: SECONDS + 301 })));
  const edge = await answer(await receive(await delivery({ id: "d-3", timestamp: SECONDS - 300 })));

  expect(stale.status).toBe(401);
  expect(stale.text).toContain("webhook-timestamp");
  expect(ahead.status).toBe(401);
  expect(edge.status).toBe(202);
  expect(dispatches()).toBe(1);
});

test("a delivery missing a signing header is refused, naming every header it lacks", async () => {
  const { receive, dispatches } = receiver();

  const { status, text } = await answer(
    await receive(new Request("http://127.0.0.1/webhook", { method: "POST", body: BODY })),
  );

  expect(status).toBe(400);
  expect(text).toContain("webhook-id");
  expect(text).toContain("webhook-timestamp");
  expect(text).toContain("webhook-signature");
  expect(dispatches()).toBe(0);
});

test("a delivery sent again with the same id is answered as received and asks for no second run", async () => {
  const { receive, dispatches } = receiver();

  const first = await answer(await receive(await delivery()));
  const again = await answer(await receive(await delivery()));

  expect(first.status).toBe(202);
  expect(again.status).toBe(200);
  expect(again.text).toContain("delivery-1");
  expect(dispatches()).toBe(1);
});

test("the ids it remembers are bounded: the oldest is forgotten first", async () => {
  const { receive, dispatches } = receiver({ rememberedDeliveries: 2 });

  for (const id of ["a", "b", "c"]) await receive(await delivery({ id }));
  const forgotten = await answer(await receive(await delivery({ id: "a" })));
  const remembered = await answer(await receive(await delivery({ id: "c" })));

  expect(forgotten.status).toBe(202);
  expect(remembered.status).toBe(200);
  expect(dispatches()).toBe(4);
});

test("an id that fails the signature is not remembered, so the signed delivery under it is still accepted", async () => {
  const { receive, dispatches } = receiver();

  await receive(await delivery({ secret: "another-secret-of-at-least-32-bytes-9876543210" }));
  const signed = await answer(await receive(await delivery()));

  expect(signed.status).toBe(202);
  expect(dispatches()).toBe(1);
});

test("a body past the cap is refused while it arrives, without reading the rest", async () => {
  const { receive, dispatches } = receiver({ maximumBodyBytes: 1024 });
  const chunk = new Uint8Array(256);
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const headers = await signDelivery(SECRET, { id: "big", timestamp: SECONDS, body: BODY });
  const request = new Request("http://127.0.0.1/webhook", {
    method: "POST",
    headers,
    body: endless,
    duplex: "half",
  } as RequestInit);

  const { status, text } = await answer(await receive(request));

  expect(status).toBe(413);
  expect(text).toContain("1024");
  expect(pulled).toBeLessThanOrEqual(1024 + 3 * chunk.byteLength);
  expect(dispatches()).toBe(0);
});

test("a declared content-length past the cap is refused before the body is read", async () => {
  const { receive } = receiver({ maximumBodyBytes: 16 });

  const { status } = await answer(await receive(await delivery()));

  expect(status).toBe(413);
});

test("a request that is not a POST is refused", async () => {
  const { receive, dispatches } = receiver();

  const { status } = await answer(await receive(new Request("http://127.0.0.1/webhook")));

  expect(status).toBe(405);
  expect(dispatches()).toBe(0);
});

test("a secret shorter than 32 bytes is refused when the receiver is made, and the refusal does not quote it", () => {
  const secret = "short-secret";
  let message = "";
  try {
    createWebhookReceiver({ secret, dispatch: () => undefined });
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toMatch(/^Webhook receiver: the secret is 12 bytes/);
  expect(message).not.toContain(secret);
});

test("no answer quotes the secret or a signature it was sent", async () => {
  const { receive } = receiver({ maximumBodyBytes: 4096 });
  const requests = [
    await delivery(),
    await delivery(),
    await delivery({ id: "x", secret: "another-secret-of-at-least-32-bytes-9876543210" }),
    await delivery({ id: "y", timestamp: SECONDS - 3600 }),
  ];
  const signatures = requests.map((request) => request.headers.get("webhook-signature") as string);

  const texts = [];
  for (const request of requests) texts.push((await answer(await receive(request))).text);

  for (const text of texts) {
    expect(text).not.toContain(SECRET);
    for (const signature of signatures) expect(text).not.toContain(signature.slice(3));
  }
});

test("a signature that is not base64 is refused as a mismatch, not thrown", async () => {
  const { receive, dispatches } = receiver();
  const request = await delivery();
  request.headers.set("webhook-signature", "v1,%%%not-base64%%%");

  const { status } = await answer(await receive(request));

  expect(status).toBe(401);
  expect(dispatches()).toBe(0);
});
