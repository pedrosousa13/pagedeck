import { CollectionError } from "./collection.js";
import { escapeUnescapedByJson, printable, quoteIdentifier } from "./escape.js";
import type { ContentStore } from "./store.js";

/**
 * `undefined` is an answer and is cached. A probe that cannot reach the image throws,
 * and the source is asked again next sync.
 */
export type ImageColorProbe = (
  src: string,
) => string | undefined | Promise<string | undefined>;

/** Bounded by what one image host tolerates: under the six-per-origin cap browsers use. */
export const DEFAULT_COLOR_CONCURRENCY = 4;

export interface SyncImageColorsInput {
  store: ContentStore;
  collection: string;
  /** Duplicates allowed; deduplicating is this module's job. */
  sources: readonly string[];
  probe: ImageColorProbe;
  /** Defaults to `DEFAULT_COLOR_CONCURRENCY`. */
  concurrency?: number;
  /** Absent means a failure is silent. */
  onWarning?: (message: string) => void;
}

/**
 * Runs outside the sync's transaction, since probing is network I/O. The writes land in
 * one short transaction at the end, sorted so two runs write the same rows (spec §11).
 */
export async function syncImageColors(
  input: SyncImageColorsInput,
): Promise<void> {
  const { store, collection, probe, onWarning } = input;
  const concurrency = input.concurrency ?? DEFAULT_COLOR_CONCURRENCY;
  refuseUnusableConcurrency(collection, input.concurrency);

  const unasked = [...new Set(input.sources)].filter(
    (src) => !store.hasImageColor(src),
  );

  const learned = new Map<string, string | undefined>();
  const failures: string[] = [];
  const faults: string[] = [];

  await inFlight(unasked, concurrency, async (src) => {
    let answer: string | undefined;
    try {
      answer = await probe(src);
    } catch (error) {
      failures.push(`  ${quoteSource(src)} — ${reasonOf(error)}`);
      return;
    }
    if (answer !== undefined && typeof answer !== "string") {
      faults.push(`  ${quoteSource(src)} — ${quoteValue(answer)} — not a string`);
      return;
    }
    learned.set(src, answer);
  });

  // A non-color answer is the site's probe at fault, exit 2 (rule 7); an unreachable host
  // is only warned about.
  if (faults.length > 0) {
    // Sorted: probes run concurrently, so completion order is a race.
    throw new CollectionError(colorFaultReport(collection, [...faults].sort()));
  }

  if (learned.size > 0) {
    const rows = [...learned.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    store.transaction(() => {
      for (const [src, color] of rows) store.setImageColor(src, color);
    });
  }

  if (failures.length > 0) {
    // Sorted: probes run concurrently, so completion order is a race.
    onWarning?.(colorFailureWarning(collection, [...failures].sort()));
  }
}

// A pool pulling from one cursor, not awaited chunks: a chunk stalls on its slowest member.
// `each` must catch its own failures; a rejection would abandon the other workers.
async function inFlight<T>(
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

function refuseUnusableConcurrency(
  collection: string,
  declared: number | undefined,
): void {
  if (declared === undefined) return;
  const reason = concurrencyFault(declared);
  if (reason === undefined) return;
  throw new CollectionError(
    `Collection "${collection}": "imageColors.concurrency" is not a number of probes — ${CONCURRENCY_FIX}:\n  ${quoteValue(declared)} — ${reason}`,
  );
}

function concurrencyFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and the limit counts probes in flight";
  }
  if (value < 1) {
    return "below one, and a sync that may run no probe at all would never cache a color";
  }
  return undefined;
}

const COLOR_FIX =
  'return a CSS color such as "#2f3a28", or undefined for an image that has none';

// Names no entry: one deduplicated source may stand for forty pages (rule 2 waived).
function colorFaultReport(collection: string, faults: readonly string[]): string {
  const count =
    faults.length === 1
      ? "1 source"
      : `${String(faults.length)} sources`;
  return `Collection "${collection}": the image color probe answered ${count} with something that is not a CSS color — ${COLOR_FIX}:\n${faults.join("\n")}`;
}

function colorFailureWarning(
  collection: string,
  failures: readonly string[],
): string {
  const subject =
    failures.length === 1
      ? "1 image source could not be probed for a dominant color, so it renders"
      : `${String(failures.length)} image sources could not be probed for a dominant color, so they render`;
  return `Collection "${collection}": ${subject} with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site's wiring; the next sync asks again:\n${failures.join("\n")}`;
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "the probe threw with no message" : printable(message);
}

// A copy of `packages/core/src/quote.ts`'s rule 6 cut, which this package cannot import;
// `packages/core/src/quote.test.ts` refuses drift between the shared declarations (#383).
const SOURCE_DELIMITER = /[?#]/;

function quoteSource(src: string): string {
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

function redactSource(value: string): string {
  const userinfo = credentialEnd(value);
  const stripped =
    userinfo === -1
      ? value
      : `${ADDRESS_SCHEME.exec(value)?.[0] ?? ""}…@${value.slice(userinfo + 1)}`;
  const delimiter = stripped.search(SOURCE_DELIMITER);
  return delimiter === -1 ? stripped : `${stripped.slice(0, delimiter + 1)}…`;
}

// `quote`'s body in `@pagedeck/core`, copied so both cut a nested string at the same depth.
function quoteValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  const json = JSON.stringify(value, (_key, held: unknown) =>
    typeof held === "string" ? redactSource(held) : held,
  );
  return json === undefined
    ? printable(String(value))
    : escapeUnescapedByJson(json);
}
