import { CollectionError } from "./collection.js";
import {
  DEFAULT_COLOR_CONCURRENCY,
  inFlight,
  quoteSource,
  quoteValue,
  reasonOf,
  refuseUnusableConcurrency,
} from "./colors.js";
import { printable } from "./escape.js";
import { MAX_PREVIEW_BYTES, imagePreviewFault } from "./preview.js";
import type { ContentStore } from "./store.js";

/**
 * In, one image source; out, a small base64 data URI painted blurred behind the image.
 * `undefined` is an answer and is cached; a throw is not, and the source is asked again.
 */
export type ImagePreviewProbe = (
  src: string,
) => string | undefined | Promise<string | undefined>;

export const DEFAULT_PREVIEW_CONCURRENCY = DEFAULT_COLOR_CONCURRENCY;

export interface ImagePreviewSource {
  readonly src: string;
  /** The entry holding it, as `/locale/path`, for the refusal to name. */
  readonly entry: string;
}

export interface SyncImagePreviewsInput {
  store: ContentStore;
  collection: string;
  /** Duplicates allowed; deduplicating is this module's job. */
  sources: readonly ImagePreviewSource[];
  probe: ImagePreviewProbe;
  /** Defaults to `DEFAULT_PREVIEW_CONCURRENCY`. */
  concurrency?: number;
  /** Absent means a failure is silent. */
  onWarning?: (message: string) => void;
}

/**
 * `syncImageColors`'s shape, with one addition: an answer is cached only once
 * `imagePreviewFault` passes it, so the store holds nothing a page could not carry.
 */
export async function syncImagePreviews(
  input: SyncImagePreviewsInput,
): Promise<void> {
  const { store, collection, probe, onWarning } = input;
  const concurrency = input.concurrency ?? DEFAULT_PREVIEW_CONCURRENCY;
  refuseUnusableConcurrency(collection, "imagePreviews", input.concurrency);

  const entriesBySource = new Map<string, Set<string>>();
  for (const { src, entry } of input.sources) {
    const entries = entriesBySource.get(src) ?? new Set<string>();
    entries.add(entry);
    entriesBySource.set(src, entries);
  }
  const unasked = [...entriesBySource.keys()].filter(
    (src) => !store.hasImagePreview(src),
  );

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
    const reason = answer === undefined ? undefined : imagePreviewFault(answer);
    if (reason !== undefined) {
      const entries = [...(entriesBySource.get(src) ?? [])].sort();
      faults.push(
        `  ${quoteSource(src)} on ${printable(entries.join(", "))} — ${quoteValue(excerpt(answer))} — ${reason}`,
      );
      return;
    }
    learned.set(src, answer as string | undefined);
  });

  if (faults.length > 0) {
    // Sorted: probes run concurrently, so completion order is a race.
    throw new CollectionError(previewFaultReport(collection, [...faults].sort()));
  }

  if (learned.size > 0) {
    const rows = [...learned.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    store.transaction(() => {
      for (const [src, preview] of rows) store.setImagePreview(src, preview);
    });
  }

  if (failures.length > 0) {
    onWarning?.(previewFailureWarning(collection, [...failures].sort()));
  }
}

const EXCERPT_LENGTH = 32;

// An over-cap answer is kilobytes of base64; the reason line carries its size.
function excerpt(answer: unknown): unknown {
  return typeof answer === "string" && answer.length > EXCERPT_LENGTH
    ? `${answer.slice(0, EXCERPT_LENGTH)}…`
    : answer;
}

const PREVIEW_FIX = `return a base64 data URI of a png, jpeg, webp, avif or gif image of at most ${String(MAX_PREVIEW_BYTES)} bytes, such as "data:image/webp;base64,UklGR…", or undefined for an image that has none`;

function previewFaultReport(collection: string, faults: readonly string[]): string {
  const count =
    faults.length === 1 ? "1 source" : `${String(faults.length)} sources`;
  return `Collection "${collection}": the image preview probe answered ${count} with something that is not an image preview — ${PREVIEW_FIX}:\n${faults.join("\n")}`;
}

function previewFailureWarning(
  collection: string,
  failures: readonly string[],
): string {
  const subject =
    failures.length === 1
      ? "1 image source could not be probed for a preview, so it renders"
      : `${String(failures.length)} image sources could not be probed for a preview, so they render`;
  return `Collection "${collection}": ${subject} with its dominant color or no placeholder — this is a warning and never a refusal, because a preview is decoration and the host that serves the image is not this site's wiring; the next sync asks again:\n${failures.join("\n")}`;
}
