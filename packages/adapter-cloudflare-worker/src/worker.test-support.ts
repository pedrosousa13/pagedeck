// An in-memory stand-in for the R2 binding and a runner for the emitted Worker. Only what
// `worker.js` reads is modelled: `get`, an object's `body`, `text()` and `writeHttpMetadata`.
import { createHash } from "node:crypto";
import vm from "node:vm";

export const ORIGIN_BINDING = "PAGEDECK_ORIGIN";

export interface StoredObject {
  body: string;
  contentType?: string;
  cacheControl?: string;
}

export interface OriginObject {
  key: string;
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  writeHttpMetadata(headers: Headers): void;
  httpEtag: string;
  uploaded: Date;
}

/** When the stand-in says every object was put. */
export const UPLOADED = new Date("2026-10-01T12:00:00.500Z");

export interface OriginBinding {
  get(key: string): Promise<OriginObject | null>;
}

/** `reads` lists every key the Worker asked for, in order, hits and misses alike. */
export function originStandIn(objects: ReadonlyMap<string, StoredObject>): {
  binding: OriginBinding;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    binding: {
      get(key) {
        reads.push(key);
        const stored = objects.get(key);
        if (stored === undefined) return Promise.resolve(null);
        return Promise.resolve({
          key,
          // R2's etag for a single-part upload is the MD5 of the body; `httpEtag` quotes it.
          httpEtag: `"${createHash("md5").update(stored.body).digest("hex")}"`,
          uploaded: UPLOADED,
          body: new Blob([stored.body]).stream(),
          text: () => Promise.resolve(stored.body),
          writeHttpMetadata(headers) {
            if (stored.contentType !== undefined) {
              headers.set("content-type", stored.contentType);
            }
            if (stored.cacheControl !== undefined) {
              headers.set("cache-control", stored.cacheControl);
            }
          },
        });
      },
    },
  };
}

/** The R2 key a deploy key is stored under: the deploy key without its leading `/`. */
export function objectKey(domain: string | undefined, path: string): string {
  return `${domain === undefined ? "" : `//${domain}`}${path}`.slice(1);
}

interface Worker {
  fetch(
    request: { method: string; url: string; headers: Headers },
    env: Record<string, unknown>,
  ): Promise<Response>;
}

const WORKERS = new Map<string, Worker>();

// The context holds only what the Workers runtime gives a module beyond the language itself,
// and only the part `worker.js` uses, so a reach for anything else throws here.
function workerOf(source: string): Worker {
  const cached = WORKERS.get(source);
  if (cached !== undefined) return cached;
  const exported = /^export default /m;
  if (!exported.test(source)) throw new Error("worker.js has no default export");
  const context = vm.createContext({ Response, Headers });
  const worker = vm.runInContext(
    `${source.replace(exported, "var worker = ")}\nworker`,
    context,
  ) as Worker;
  WORKERS.set(source, worker);
  return worker;
}

/** A plain `{ method, url }`, so a test can hand the Worker a URL no `Request` would keep. */
export async function runWorker(
  source: string,
  request: { method: string; url: string; headers?: Record<string, string> },
  origin: OriginBinding,
): Promise<Response> {
  return await workerOf(source).fetch(
    { method: request.method, url: request.url, headers: new Headers(request.headers) },
    { [ORIGIN_BINDING]: origin },
  );
}
