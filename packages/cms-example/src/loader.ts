import type { EntryId, Loader, SyncResult } from "@pagedeck/content";

/** What a page holds on the wire, unread: the collection's schema says what a block is. */
export interface PageEntry {
  readonly title: unknown;
  readonly blocks: unknown;
}

export interface ExampleCmsLoaderOptions {
  /** The root of the CMS's API; `pages` and `changes` resolve against it. */
  readonly endpoint: string;
  readonly locale: string;
  /** How long one request may take, from sending it to the body's last byte. Defaults to 30000. */
  readonly timeoutMs?: number;
  /** The most bytes one response body may hold before the sync fails. Defaults to 16 MiB. */
  readonly maximumBodyBytes?: number;
}

interface Limits {
  readonly timeoutMs: number;
  readonly maximumBodyBytes: number;
}

interface WirePage extends PageEntry {
  readonly id: string;
}

interface ListBody {
  readonly pages: readonly WirePage[];
  readonly nextPage: number | null;
  readonly revision: number;
}

interface ChangesBody {
  readonly pages: readonly WirePage[];
  readonly deleted: readonly string[];
  readonly revision: number;
}

// The bound sits on the loop, not on the CMS agreeing to stop (CONTEXT.md, "A paged read
// has a maximum page count").
const MAXIMUM_PAGES = 1000;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_BODY_BYTES = 16 * 1024 * 1024;
// The longest delay a Node timer takes: past it, `AbortSignal.timeout` fires after 1 ms.
const LONGEST_TIMEOUT_MS = 2 ** 31 - 1;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const FIX = "check that the endpoint the config names is the root of the CMS's API";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// docs/error-messages.md, rule 6: scheme, host and path, and nothing else.
function quote(url: URL): string {
  return `CMS request "GET ${url.origin}${url.pathname}"`;
}

function pageFaults(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body["pages"])) return ["pages is not a list"];
  return body["pages"].flatMap((page: unknown, index) => {
    if (!isObject(page)) return [`pages[${String(index)}] is not an object`];
    return typeof page["id"] === "string" ? [] : [`pages[${String(index)}].id is not a string`];
  });
}

function revisionFaults(body: Record<string, unknown>): string[] {
  return isWholeNumber(body["revision"]) ? [] : ["revision is not a whole number"];
}

function listFaults(body: Record<string, unknown>): string[] {
  const next = body["nextPage"];
  return [
    ...pageFaults(body),
    ...(next === null || isWholeNumber(next) ? [] : ["nextPage is not a whole number or null"]),
    ...revisionFaults(body),
  ];
}

function changesFaults(body: Record<string, unknown>): string[] {
  const deleted = body["deleted"];
  return [
    ...pageFaults(body),
    ...(Array.isArray(deleted)
      ? deleted.flatMap((id: unknown, index) =>
          typeof id === "string" ? [] : [`deleted[${String(index)}] is not a string`],
        )
      : ["deleted is not a list"]),
    ...revisionFaults(body),
  ];
}

function timedOut(url: URL, limits: Limits, cause: unknown): Error {
  return new Error(
    `${quote(url)}: the CMS did not finish answering within ${String(limits.timeoutMs)} ms, so the loader stopped waiting — check that the CMS is running at the endpoint the config names, or raise timeoutMs in the loader's options if it is slow`,
    { cause },
  );
}

function redirected(url: URL, response: Response): Error {
  const location = response.headers.get("location");
  const target =
    location !== null && URL.canParse(location, url.href) ? new URL(location, url) : undefined;
  const redirect =
    target === undefined
      ? "a redirect with no location the loader can read"
      : `a redirect to "${target.origin}${target.pathname}"`;
  return new Error(
    `${quote(url)}: the CMS answered ${String(response.status)}, ${redirect} — the loader follows no redirect, so every request stays on the host the endpoint names; point the endpoint at the root of the CMS's API`,
  );
}

const isTimeout = (error: unknown): boolean => error instanceof Error && error.name === "TimeoutError";

// Counts bytes as they arrive and stops at the cap, so an endless body is never held whole.
async function cappedText(url: URL, response: Response, limits: Limits): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read().catch((cause: unknown) => {
      if (isTimeout(cause)) throw timedOut(url, limits, cause);
      throw new Error(
        `${quote(url)}: the connection failed while the body was read — check that the CMS is running at the endpoint the config names, and run the sync again`,
        { cause },
      );
    });
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limits.maximumBodyBytes) {
      await reader.cancel();
      throw new Error(
        `${quote(url)}: the body is larger than ${String(limits.maximumBodyBytes)} bytes, so the rest was not read — ${FIX}, or raise maximumBodyBytes in the loader's options if its responses are this large`,
      );
    }
    chunks.push(chunk.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function read<T>(
  url: URL,
  faultsOf: (body: Record<string, unknown>) => string[],
  limits: Limits,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch (cause) {
    if (isTimeout(cause)) throw timedOut(url, limits, cause);
    throw new Error(
      `${quote(url)}: failed before the CMS answered — check that the CMS is running at the endpoint the config names`,
      { cause },
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw redirected(url, response);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${quote(url)}: the CMS answered ${String(response.status)} — ${FIX}`);
  }
  const text = await cappedText(url, response, limits);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${quote(url)}: the body is not JSON — ${FIX}`, { cause });
  }
  const faults = isObject(body) ? faultsOf(body) : ["the body is not an object"];
  if (faults.length > 0) {
    throw new Error(
      `${quote(url)}: the body is not the list this loader reads — ${FIX}:\n${faults.map((fault) => `  ${fault}`).join("\n")}`,
    );
  }
  return body as T;
}

function refuseEndpoint(endpoint: string): URL {
  const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (url?.protocol !== "http:" && url?.protocol !== "https:") {
    throw new Error(
      "CMS endpoint: is not an http: or https: URL — pass the URL the CMS serves its API at, such as http://127.0.0.1:4310/",
    );
  }
  // `fetch` refuses a URL with userinfo in an error that quotes it whole (#726).
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "CMS endpoint: carries a user name or password before its host — pass the endpoint without them, and send the credential in a request header such as authorization",
    );
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `CMS endpoint: is an http: URL on host "${url.hostname}", which is not loopback — http: carries every request, and any token in its headers, across the network in clear text; use https:, or keep http: for 127.0.0.1, ::1 or localhost`,
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function refuseLimits(options: ExampleCmsLoaderOptions): Limits {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maximumBodyBytes = DEFAULT_MAXIMUM_BODY_BYTES } = options;
  const faults = [
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= LONGEST_TIMEOUT_MS
      ? []
      : [`timeoutMs is not a whole number of milliseconds from 1 to ${String(LONGEST_TIMEOUT_MS)}`]),
    ...(Number.isSafeInteger(maximumBodyBytes) && maximumBodyBytes >= 1
      ? []
      : [`maximumBodyBytes is not a whole number of bytes from 1 to ${String(Number.MAX_SAFE_INTEGER)}`]),
  ];
  if (faults.length > 0) {
    throw new Error(
      `CMS loader options: ${String(faults.length)} ${faults.length === 1 ? "limit" : "limits"} cannot be used — fix each in the call to defineExampleCmsLoader:\n${faults.map((fault) => `  ${fault}`).join("\n")}`,
    );
  }
  return { timeoutMs, maximumBodyBytes };
}

export function defineExampleCmsLoader(options: ExampleCmsLoaderOptions): Loader<PageEntry> {
  const root = refuseEndpoint(options.endpoint);
  const limits = refuseLimits(options);
  const idOf = (id: string): EntryId => ({ locale: options.locale, path: id });

  return {
    async syncAll(writer): Promise<SyncResult> {
      const changed: EntryId[] = [];
      let cursor: number | undefined;
      let next: number | null = 1;
      for (let requests = 1; next !== null; requests += 1) {
        const url: URL = new URL(`pages?page=${String(next)}`, root);
        const body: ListBody = await read<ListBody>(url, listFaults, limits);
        // The revision the walk started at: a page edited after it is synced again next time.
        cursor ??= body.revision;
        if (body.revision !== cursor) {
          throw new Error(
            `${quote(url)}: the CMS moved from revision ${String(cursor)} to ${String(body.revision)} while the list was read, so a page could have shifted past the loader and been pruned as deleted — run the sync again`,
          );
        }
        for (const { id, title, blocks } of body.pages) {
          writer.upsert({ ...idOf(id), data: { title, blocks } });
          changed.push(idOf(id));
        }
        next = body.nextPage;
        if (next !== null && requests === MAXIMUM_PAGES) {
          throw new Error(
            `${quote(url)}: the list still names a next page after ${String(MAXIMUM_PAGES)} pages, so the loader stops rather than follow a list that may never end — check that the CMS answers nextPage null on its last page`,
          );
        }
      }
      // The list holds every page, so a page it did not name is gone.
      return { changed, deleted: [], authoritative: true, cursor: cursor ?? 0 };
    },

    async syncSince(writer, cursor): Promise<SyncResult> {
      const url = new URL(`changes?since=${String(cursor)}`, root);
      const body = await read<ChangesBody>(url, changesFaults, limits);
      if (body.revision < cursor) {
        throw new Error(
          `${quote(url)}: the CMS is at revision ${String(body.revision)}, behind the cursor ${String(cursor)} the last sync stored, so it would report no edit until it passed ${String(cursor)} and the edits before then would never be synced — run pagedeck sync without --incremental to read every page again`,
        );
      }
      for (const { id, title, blocks } of body.pages) {
        writer.upsert({ ...idOf(id), data: { title, blocks } });
      }
      return {
        changed: body.pages.map(({ id }) => idOf(id)),
        deleted: body.deleted.map(idOf),
        cursor: body.revision,
      };
    },
  };
}
