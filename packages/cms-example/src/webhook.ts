import type { webcrypto } from "node:crypto";

export interface WebhookReceiverOptions {
  /** Shared with the CMS and with nothing else. At least 32 bytes. */
  readonly secret: string;
  /** Asks for one run of the publishing job. Called with nothing from the delivery. */
  readonly dispatch: () => void;
  /** How far a delivery's timestamp may be from now. Default 300. */
  readonly toleranceSeconds?: number;
  /** Default 65536. */
  readonly maximumBodyBytes?: number;
  /** How many delivery ids are kept for the duplicate check. Default 1000. */
  readonly rememberedDeliveries?: number;
  /** Milliseconds since the epoch. Default `Date.now`. */
  readonly now?: () => number;
}

export interface Delivery {
  readonly id: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
  readonly body: string;
}

const MINIMUM_SECRET_BYTES = 32;

const MAXIMUM_SIGNATURES = 4;

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<webcrypto.CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function signedContent(id: string, timestamp: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(`${id}.${timestamp}.`);
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head);
  bytes.set(body, head.byteLength);
  return bytes;
}

/** The headers a CMS sends with a delivery. */
export async function signDelivery(secret: string, delivery: Delivery): Promise<Record<string, string>> {
  const timestamp = String(delivery.timestamp);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    signedContent(delivery.id, timestamp, encoder.encode(delivery.body)),
  );
  return {
    "content-type": "application/json",
    "webhook-id": delivery.id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`,
  };
}

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

type Body = { kind: "read"; bytes: Uint8Array } | { kind: "too-large" };

async function readCapped(request: Request, cap: number): Promise<Body> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (declared > cap) return { kind: "too-large" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "read", bytes };
}

function signatures(header: string): Uint8Array<ArrayBuffer>[] {
  return header
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .slice(0, MAXIMUM_SIGNATURES)
    .flatMap((part) => {
      try {
        return [Uint8Array.from(atob(part.slice(3)), (character) => character.charCodeAt(0))];
      } catch {
        return [];
      }
    });
}

/**
 * A `Request -> Response` handler, so it mounts in any app that speaks the fetch API.
 * Every answer names a header or a limit, never the secret or a signature.
 */
export function createWebhookReceiver(
  options: WebhookReceiverOptions,
): (request: Request) => Promise<Response> {
  const secretBytes = encoder.encode(options.secret).byteLength;
  if (secretBytes < MINIMUM_SECRET_BYTES) {
    throw new Error(
      `Webhook receiver: the secret is ${String(secretBytes)} bytes, under the ${String(MINIMUM_SECRET_BYTES)} an HMAC-SHA256 key needs — generate one with "openssl rand -base64 32" and give the same value to the CMS`,
    );
  }
  const limits = {
    maximumBodyBytes: options.maximumBodyBytes ?? 65_536,
    toleranceSeconds: options.toleranceSeconds ?? 300,
    rememberedDeliveries: options.rememberedDeliveries ?? 1000,
  };
  const faults = Object.entries(limits)
    .filter(([, value]) => !(Number.isSafeInteger(value) && value > 0))
    .map(([name, value]) => `"${name}" is ${String(value)}`);
  if (faults.length > 0) {
    throw new Error(
      `Webhook receiver options: ${String(faults.length)} ${faults.length === 1 ? "limit is" : "limits are"} not a whole number above zero — give each one as such, or leave it out for its default: ${faults.join(", ")}`,
    );
  }
  const cap = limits.maximumBodyBytes;
  const tolerance = limits.toleranceSeconds;
  const remembered = limits.rememberedDeliveries;
  const now = options.now ?? Date.now;
  const verifying = hmacKey(options.secret, "verify");
  const seen = new Set<string>();

  return async (request) => {
    if (request.method !== "POST") {
      return refuse(405, "Webhook: the receiver takes POST only");
    }
    const id = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");
    const signature = request.headers.get("webhook-signature");
    if (id === null || timestamp === null || signature === null) {
      const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature };
      const missing = Object.entries(headers)
        .filter(([, value]) => value === null)
        .map(([name]) => name);
      return refuse(400, `Webhook: the delivery has no ${missing.join(", ")} header — send each one the CMS signs with`);
    }
    const seconds = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
    if (!(Math.abs(now() / 1000 - seconds) <= tolerance)) {
      return refuse(
        401,
        `Webhook delivery: webhook-timestamp is not within ${String(tolerance)} seconds of the receiver's clock — check both clocks; a replayed delivery is refused the same way`,
      );
    }
    const body = await readCapped(request, cap);
    if (body.kind === "too-large") {
      return refuse(
        413,
        `Webhook delivery: the body is over ${String(cap)} bytes — a delivery names what changed, not the content; raise maximumBodyBytes only if the CMS sends more`,
      );
    }
    const content = signedContent(id, timestamp, body.bytes);
    let valid = false;
    for (const candidate of signatures(signature)) {
      if (await crypto.subtle.verify("HMAC", await verifying, candidate, content)) valid = true;
    }
    if (!valid) {
      return refuse(
        401,
        `Webhook delivery: none of the first ${String(MAXIMUM_SIGNATURES)} webhook-signature values matches the body — check that the CMS and the receiver hold the same secret`,
      );
    }
    if (seen.has(id)) {
      return Response.json({ received: id, duplicate: true }, { status: 200 });
    }
    seen.add(id);
    if (seen.size > remembered) {
      for (const oldest of seen) {
        seen.delete(oldest);
        break;
      }
    }
    options.dispatch();
    return Response.json({ received: id }, { status: 202 });
  };
}
