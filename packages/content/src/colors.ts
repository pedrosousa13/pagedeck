import { CollectionError } from "./collection.js";
import { printable, quoteIdentifier } from "./escape.js";
import { excerpt, imageColorFault } from "./preview.js";
import {
  inFlight,
  quoteSource,
  quoteValue,
  reasonOf,
  redactColor,
  refuseUnusableConcurrency,
} from "./probing.js";
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

export interface ImageColorSource {
  readonly src: string;
  /** The entry holding it, as `/locale/path`, for the refusal to name. */
  readonly entry: string;
}

export interface SyncImageColorsInput {
  store: ContentStore;
  collection: string;
  /** Duplicates allowed; deduplicating is this module's job. */
  sources: readonly ImageColorSource[];
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
  refuseUnusableConcurrency(collection, "imageColors", "a color", input.concurrency);

  const entriesBySource = new Map<string, Set<string>>();
  for (const { src, entry } of input.sources) {
    const entries = entriesBySource.get(src) ?? new Set<string>();
    entries.add(entry);
    entriesBySource.set(src, entries);
  }
  const unasked = [...entriesBySource.keys()].filter((src) => {
    if (!store.hasImageColor(src)) return true;
    const cached = store.getImageColor(src);
    return cached !== undefined && imageColorFault(cached) !== undefined;
  });

  const learned = new Map<string, string | undefined>();
  const failures: string[] = [];
  const faults: string[] = [];

  await inFlight(unasked, concurrency, async (src) => {
    let answer: unknown;
    try {
      answer = await probe(src);
    } catch (error) {
      failures.push(`  ${quoteSource(src)} — ${reasonOf(error)}`);
      return;
    }
    const reason = answer === undefined ? undefined : imageColorFault(answer);
    if (reason !== undefined) {
      const entries = [...(entriesBySource.get(src) ?? [])].sort();
      faults.push(
        `  ${quoteSource(src)} on ${printable(entries.join(", "))} — ${quoteAnswer(answer)} — ${reason}`,
      );
      return;
    }
    learned.set(src, answer as string | undefined);
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

function quoteAnswer(answer: unknown): string {
  return typeof answer === "string"
    ? quoteIdentifier(excerpt(answer, redactColor) as string)
    : quoteValue(answer);
}

const COLOR_FIX =
  'return a CSS color as "#" and 3, 4, 6 or 8 hex digits, such as "#2f3a28", or as rgb() of three whole numbers from 0 to 255, such as "rgb(47 58 40)", or undefined for an image that has none';

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
