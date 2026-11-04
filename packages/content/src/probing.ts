import { CollectionError } from "./collection.js";
import { escapeUnescapedByJson, printable, quoteIdentifier } from "./escape.js";

// A pool pulling from one cursor, not awaited chunks: a chunk stalls on its slowest member.
// `each` must catch its own failures; a rejection would abandon the other workers.
export async function inFlight<T>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await each(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
}

const CONCURRENCY_FIX =
  "write a whole number of probes above zero, such as { concurrency: 4 }";

export function refuseUnusableConcurrency(
  collection: string,
  setting: "imageColors" | "imagePreviews",
  /** What a sync that probes nothing would never cache, as "a color". */
  cached: string,
  declared: number | undefined,
): void {
  if (declared === undefined) return;
  const reason = concurrencyFault(declared, cached);
  if (reason === undefined) return;
  throw new CollectionError(
    `Collection "${collection}": "${setting}.concurrency" is not a number of probes — ${CONCURRENCY_FIX}:\n  ${quoteValue(declared)} — ${reason}`,
  );
}

function concurrencyFault(value: unknown, cached: string): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and the limit counts probes in flight";
  }
  if (value < 1) {
    return `below one, and a sync that may run no probe at all would never cache ${cached}`;
  }
  return undefined;
}

export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "the probe threw with no message" : printable(message);
}

// A copy of `packages/core/src/quote.ts`'s rule 6 cut, which this package cannot import;
// `packages/core/src/quote.test.ts` refuses drift between the shared declarations (#383).
const SOURCE_DELIMITER = /[?#]/;

export function quoteSource(src: string): string {
  return quoteIdentifier(redactSource(src));
}

const ADDRESS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:(?:\/\/)?/;

const ADDRESS_AUTHORITY = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function credentialEnd(value: string): number {
  const at = value.lastIndexOf("@");
  if (at === -1) return -1;
  const span = value.slice(0, at).replace(ADDRESS_AUTHORITY, "");
  return !span.includes("/") || span.includes(":") || span.includes("@")
    ? at
    : -1;
}

export function redactCredential(value: string): string {
  const userinfo = credentialEnd(value);
  return userinfo === -1
    ? value
    : `${ADDRESS_SCHEME.exec(value)?.[0] ?? ""}…@${value.slice(userinfo + 1)}`;
}

export function redactSource(value: string): string {
  const stripped = redactCredential(value);
  const delimiter = stripped.search(SOURCE_DELIMITER);
  return delimiter === -1 ? stripped : `${stripped.slice(0, delimiter + 1)}…`;
}

// `quote`'s body in `@pagedeck/core`, copied so both cut a nested string at the same depth.
export function quoteValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  const json = JSON.stringify(value, (_key, held: unknown) =>
    typeof held === "string" ? redactSource(held) : held,
  );
  return json === undefined
    ? printable(String(value))
    : escapeUnescapedByJson(json);
}
