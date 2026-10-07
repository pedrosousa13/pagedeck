import type { StandardSchemaV1 } from "@standard-schema/spec";
import { syncImageColors } from "./colors.js";
import { printable, quoteIdentifier } from "./escape.js";
import type { ImageColorProbe } from "./colors.js";
import type {
  ComponentUsage,
  ContentStore,
  ContentStoreReader,
  Entry,
  InvertedWindowEntry,
  PublishWindow,
} from "./store.js";

export class CollectionError extends Error {
  override readonly name = "CollectionError";
}

/**
 * Identifiers, not path fragments: a sync refuses an id that is one before anything is
 * written (ADR-0004), so a stored id may be taken as given.
 */
export interface EntryId {
  locale: string;
  path: string;
}

export interface SyncResult {
  changed: EntryId[];
  /** Echoed as given; nothing checks it against the rows that were there. */
  deleted: EntryId[];
  /**
   * Every entry this sync did not write is gone, and the framework removes it. Only a
   * full sync may set it.
   */
  authoritative?: boolean;
  /** Loader-owned watermark for the next `syncSince`, not the store's `seq`. */
  cursor: number;
}

/**
 * Good only until the sync method it was handed to returns; a later call is never
 * replayed. One unusable upsert id fails the whole sync.
 */
export interface CollectionWriter<T> {
  upsert(entry: { locale: string; path: string; data: T }): void;
  delete(id: EntryId): void;
}

export interface Loader<T> {
  syncAll(writer: CollectionWriter<T>): SyncResult | Promise<SyncResult>;
  syncSince(
    writer: CollectionWriter<T>,
    cursor: number,
  ): SyncResult | Promise<SyncResult>;
  fetchOne?(id: EntryId): T | undefined | Promise<T | undefined>;
}

export interface TemplateUsage<T> {
  /** Undefined for a tree-driven entry, which falls through to `extractUsage`. */
  templateOf: (entry: Entry<T>) => string | undefined;
  /** Partial: a name with no declaration is refused at sync, not read as componentless. */
  byTemplate: Partial<Readonly<Record<string, readonly ComponentUsage[]>>>;
}

// `false` only when the two entry types are mutually assignable: with no schema, what is
// stored is what the loader produced. The tuples keep the check non-distributive.
type Unvalidated<TOut, TIn> = [TOut, TIn] extends [TIn, TOut] ? false : never;

/**
 * `TOut` is the stored and read type (the schema's output), `TIn` the loader's (#195).
 * The read type comes first so `Collection<X>` keeps meaning the shape a page receives.
 */
export interface Collection<TOut, TIn = TOut> {
  name: string;
  loader: Loader<TIn>;
  /** Must be synchronous: it runs inside the transaction that writes the entry. */
  extractUsage?: (entry: Entry<TOut>) => ComponentUsage[];
  templates?: TemplateUsage<TOut>;
  /**
   * Field holding an entry's publish timestamp, dotted for nesting (`meta.publish_at`).
   * A field name, not an accessor, because `listDueEntries` selects in SQL.
   */
  publishField?: string;
  /** The window's other end, half-open: out at this instant. Absent or null never expires. */
  unpublishField?: string;
  /**
   * Required: `false` stores what the loader hands over unchecked, so no site skips
   * validation by omission.
   */
  schema: StandardSchemaV1<unknown, TOut> | Unvalidated<TOut, TIn>;
  imageColors?: ImageColorsSetting<TOut>;
}

// Probed after the sync transaction commits, so a fault costs the colors, never the content.
export interface ImageColorsSetting<T> {
  /** Every image source one entry holds, in any order, duplicates allowed. */
  extractSources: (entry: Entry<T>) => readonly string[];
  probe: ImageColorProbe;
  /** Defaults to `DEFAULT_COLOR_CONCURRENCY`. */
  concurrency?: number;
}

export interface CollectionSyncOptions {
  /** Where a warning goes; absent means a warning is dropped. */
  onWarning?: (message: string) => void;
}

// For a caller past the types (plain JavaScript or a cast): without it an absent schema
// reads as one that throws, blaming the entry.
function refuseAbsentSchema(collection: {
  name: string;
  schema?: unknown;
}): void {
  if (collection.schema !== undefined) return;
  throw new CollectionError(
    `Collection "${collection.name}": declares no schema, so nothing checks what the loader hands over — declare a Standard Schema to validate its entries, or schema: false to store them unchecked`,
  );
}

export function defineCollection<S extends StandardSchemaV1, TIn>(
  collection: Omit<
    Collection<StandardSchemaV1.InferOutput<S>, TIn>,
    "schema"
  > & {
    schema: S;
  },
): Collection<StandardSchemaV1.InferOutput<S>, TIn>;
/**
 * `schema: false` keeps this overload from catching a schema whose loader disagrees,
 * which would widen every query to `unknown`.
 */
export function defineCollection<T>(
  collection: Omit<Collection<T>, "schema"> & { schema: false },
): Collection<T>;
export function defineCollection<TOut, TIn>(
  collection: Collection<TOut, TIn>,
): Collection<TOut, TIn> {
  refuseAbsentSchema(collection);
  return collection;
}

type BufferedWrite<T> =
  | { kind: "upsert"; locale: string; path: string; data: T }
  | { kind: "delete"; locale: string; path: string };

// Buffers, so the replay runs in one synchronous transaction with none open across an await.
function makeWriter<T>(buffer: BufferedWrite<T>[]): CollectionWriter<T> {
  return {
    upsert(entry) {
      buffer.push({ kind: "upsert", ...entry });
    },
    delete(id) {
      buffer.push({ kind: "delete", locale: id.locale, path: id.path });
    },
  };
}

function issueField(issue: StandardSchemaV1.Issue): string {
  const segments = issue.path ?? [];
  if (segments.length === 0) return "(whole entry)";
  return segments
    .map((segment) =>
      typeof segment === "object" ? String(segment.key) : String(segment),
    )
    .join(".");
}

async function validateEntry<T>(
  collectionName: string,
  schema: StandardSchemaV1<unknown, T>,
  entry: { locale: string; path: string; data: unknown },
): Promise<
  { value: T; lines?: undefined } | { value?: undefined; lines: string[] }
> {
  let result: StandardSchemaV1.Result<T>;
  try {
    result = await schema["~standard"].validate(entry.data);
  } catch (error) {
    throw new Error(
      `Collection "${collectionName}": schema threw validating entry ${quoteIdentifier(`${entry.locale}/${entry.path}`)}`,
      { cause: error },
    );
  }
  if (result.issues === undefined) return { value: result.value };
  return {
    lines: result.issues.map(
      (issue) =>
        `  ${printable(`/${entry.locale}/${entry.path}: ${issueField(issue)} — ${issue.message}`)}`,
    ),
  };
}

function schemaFailure(
  collectionName: string,
  failed: number,
  lines: readonly string[],
): Error {
  const subject = failed === 1 ? "1 entry does not" : `${failed} entries do not`;
  return new Error(
    `Collection "${collectionName}": ${subject} match the collection schema — fix the content, or relax the schema:\n${lines.join("\n")}`,
  );
}

// Returns the schema's output, not its input: a coercing or narrowing schema's result is
// what is stored. Runs before the replay because `validate` may be async.
async function validateBuffer<TOut, TIn>(
  collectionName: string,
  schema: StandardSchemaV1<unknown, TOut>,
  buffer: readonly BufferedWrite<TIn>[],
): Promise<BufferedWrite<TOut>[]> {
  const validated: BufferedWrite<TOut>[] = [];
  const lines: string[] = [];
  let failed = 0;

  for (const write of buffer) {
    if (write.kind !== "upsert") {
      validated.push(write);
      continue;
    }
    const verdict = await validateEntry(collectionName, schema, write);
    if (verdict.lines === undefined) {
      validated.push({ ...write, data: verdict.value });
      continue;
    }
    failed += 1;
    lines.push(...verdict.lines);
  }

  if (failed > 0) throw schemaFailure(collectionName, failed, lines);
  return validated;
}

type LoaderOperation = "syncAll" | "syncSince" | "fetchOne";

function loaderFailed(
  collection: string,
  operation: LoaderOperation,
  cause: unknown,
): Error {
  return new Error(`Collection "${collection}": loader ${operation} failed`, {
    cause,
  });
}

function usageOf<TOut, TIn>(
  collection: Collection<TOut, TIn>,
  entry: Entry<TOut>,
): readonly ComponentUsage[] {
  const { templates } = collection;
  if (templates !== undefined) {
    const template = templates.templateOf(entry);
    if (template !== undefined) {
      // `Object.hasOwn`, not an index: a template named "toString" would read
      // `Object.prototype` and pass as declared.
      const declared = Object.hasOwn(templates.byTemplate, template)
        ? templates.byTemplate[template]
        : undefined;
      if (declared === undefined) {
        throw new CollectionError(
          `Collection "${collection.name}": template ${quoteIdentifier(template)} declares no component usage — declare its components in the collection's byTemplate, or stop returning the name from templateOf`,
        );
      }
      return declared;
    }
  }
  return collection.extractUsage?.(entry) ?? [];
}

// Reads the entry back because `seq` exists only once the row lands.
function writeUsage<TOut, TIn>(
  store: ContentStore,
  collection: Collection<TOut, TIn>,
  locale: string,
  path: string,
): void {
  const entry = store.getEntry<TOut>(collection.name, locale, path);
  if (entry === undefined) {
    throw new Error(
      `Collection "${collection.name}": entry ${quoteIdentifier(`${locale}/${path}`)} is absent right after being written`,
    );
  }
  const usage = usageOf(collection, entry);
  store.clearUsage(collection.name, locale, path);
  for (const component of usage) {
    store.upsertUsage({
      ...component,
      collection: collection.name,
      locale,
      path,
    });
  }
}

function refuseAuthoritativeDelta(
  collectionName: string,
  operation: "syncAll" | "syncSince",
  result: SyncResult,
): void {
  if (operation !== "syncSince" || result.authoritative !== true) return;
  throw new CollectionError(
    `Collection "${collectionName}": loader syncSince reported an authoritative sync, but only a full sync observes the whole source — an incremental sync reports a delta, so pruning against it would delete every entry it did not mention — report authoritative from syncAll only`,
  );
}

// Spares the closed buffer's ids, not `SyncResult.changed`, which the loader can still
// mutate. Keys join on a newline because a locale may hold a `/`.
function pruneUnwritten<TOut>(
  store: ContentStore,
  collectionName: string,
  writes: readonly BufferedWrite<TOut>[],
): void {
  const written = new Set(
    writes
      .filter((write) => write.kind === "upsert")
      .map((write) => `${write.locale}\n${write.path}`),
  );
  for (const entry of store.listEntries(collectionName)) {
    if (written.has(`${entry.locale}\n${entry.path}`)) continue;
    store.deleteEntry(collectionName, entry.locale, entry.path);
  }
}

async function runSync<TOut, TIn>(
  store: ContentStore,
  collection: Collection<TOut, TIn>,
  operation: "syncAll" | "syncSince",
  run: (writer: CollectionWriter<TIn>) => SyncResult | Promise<SyncResult>,
  options: CollectionSyncOptions | undefined,
): Promise<SyncResult> {
  refuseAbsentSchema(collection);

  const buffer: BufferedWrite<TIn>[] = [];
  let result: SyncResult;
  try {
    result = await run(makeWriter<TIn>(buffer));
  } catch (error) {
    throw loaderFailed(collection.name, operation, error);
  }

  refuseAuthoritativeDelta(collection.name, operation, result);

  // Taken out now: a loader that kept the writer can still `upsert` while the steps below
  // await, and a live array would hand the replay an id nobody read (ADR-0004).
  const buffered = buffer.splice(0);

  // Ids before schemas, and even under `schema: false`: an id is a key, not content (ADR-0004).
  refuseUnusableIds(collection.name, buffered);

  // `Unvalidated` admits `false` only where the loader's type is the read type.
  const writes: BufferedWrite<TOut>[] =
    collection.schema === false
      ? (buffered as unknown as BufferedWrite<TOut>[])
      : await validateBuffer(collection.name, collection.schema, buffered);

  const tracksUsage =
    collection.extractUsage !== undefined || collection.templates !== undefined;

  let applying: BufferedWrite<TOut> | undefined;
  try {
    store.transaction(() => {
      for (const write of writes) {
        applying = write;
        if (write.kind === "upsert") {
          store.upsertEntry({
            collection: collection.name,
            locale: write.locale,
            path: write.path,
            data: write.data,
          });
          if (tracksUsage) {
            writeUsage(store, collection, write.locale, write.path);
          }
        } else {
          store.deleteEntry(collection.name, write.locale, write.path);
        }
      }
      applying = undefined;
      if (result.authoritative === true) {
        pruneUnwritten(store, collection.name, writes);
      }
      store.setCursor(collection.name, result.cursor);
    });
  } catch (error) {
    const where =
      applying === undefined
        ? "the cursor"
        : `entry ${quoteIdentifier(`${applying.locale}/${applying.path}`)}`;
    const message = `Collection "${collection.name}": ${operation} failed writing ${where}`;
    // Keeps `CollectionError`'s class: the CLI reads the class thrown, never the cause chain.
    throw error instanceof CollectionError
      ? new CollectionError(message, { cause: error })
      : new Error(message, { cause: error });
  }

  // After the commit: a probe is network I/O, and a transaction body may not await.
  try {
    await writeImageColors(store, collection, options);
  } catch (error) {
    const message = `Collection "${collection.name}": ${operation} stored every entry it was given, then failed fetching dominant colors`;
    throw error instanceof CollectionError
      ? new CollectionError(message, { cause: error })
      : new Error(message, { cause: error });
  }
  return result;
}

// Every entry of the collection, not only this sync's: a failed probe is not cached, and
// a source reached only through unchanged entries would never be asked again.
async function writeImageColors<TOut, TIn>(
  store: ContentStore,
  collection: Collection<TOut, TIn>,
  options: CollectionSyncOptions | undefined,
): Promise<void> {
  const setting = collection.imageColors;
  if (setting === undefined) return;

  const sources: string[] = [];
  for (const entry of store.listEntries<TOut>(collection.name)) {
    sources.push(...setting.extractSources(entry));
  }

  await syncImageColors({
    store,
    collection: collection.name,
    sources,
    probe: setting.probe,
    concurrency: setting.concurrency,
    onWarning: options?.onWarning,
  });
}

export async function syncCollection<TOut, TIn = TOut>(
  store: ContentStore,
  collection: Collection<TOut, TIn>,
  options?: CollectionSyncOptions,
): Promise<SyncResult> {
  return runSync(
    store,
    collection,
    "syncAll",
    (writer) => collection.loader.syncAll(writer),
    options,
  );
}

/**
 * With no cursor given or stored, the collection has never synced: a caller bug, not a
 * reason to run a full sync.
 */
export async function syncCollectionSince<TOut, TIn = TOut>(
  store: ContentStore,
  collection: Collection<TOut, TIn>,
  cursor?: number,
  options?: CollectionSyncOptions,
): Promise<SyncResult> {
  const from = cursor ?? store.getCursor(collection.name);
  if (from === undefined) {
    throw new Error(
      `Collection "${collection.name}": no cursor to sync since — run a full sync first`,
    );
  }
  return runSync(
    store,
    collection,
    "syncSince",
    (writer) => collection.loader.syncSince(writer, from),
    options,
  );
}

/** Never consults the loader; `getEntryCached` falls back to it. */
export function getEntry<TOut, TIn = TOut>(
  store: ContentStoreReader,
  collection: Collection<TOut, TIn>,
  id: EntryId,
): Entry<TOut> | undefined {
  return store.getEntry<TOut>(collection.name, id.locale, id.path);
}

export function listEntries<TOut, TIn = TOut>(
  store: ContentStoreReader,
  collection: Collection<TOut, TIn>,
  locale?: string,
): Entry<TOut>[] {
  return store.listEntries<TOut>(collection.name, locale);
}

/**
 * `now` is a caller-supplied ISO-8601 UTC instant. Refuses a collection that declares
 * neither field, and every entry whose window is inverted.
 */
export function listDueEntries<TOut, TIn = TOut>(
  store: ContentStoreReader,
  collection: Collection<TOut, TIn>,
  now: string,
): Entry<TOut>[] {
  const { publishField, unpublishField } = collection;
  let window: PublishWindow;
  if (publishField !== undefined) window = { publishField, unpublishField };
  else if (unpublishField !== undefined) window = { unpublishField };
  else {
    throw new CollectionError(
      `Collection "${collection.name}": declares no publishField and no unpublishField, so no entry has a publication schedule — declare one to query due entries`,
    );
  }
  if (publishField !== undefined && unpublishField !== undefined) {
    const inverted = store.listInvertedWindows<TOut>(
      collection.name,
      publishField,
      unpublishField,
    );
    if (inverted.length > 0) {
      throw new CollectionError(
        invertedWindowReport(
          collection.name,
          publishField,
          unpublishField,
          inverted,
        ),
      );
    }
  }
  return store.listDue<TOut>(collection.name, window, now);
}

const INVERTED_WINDOW_FIX =
  "fix the two instants, or declare only one end of the window";

function invertedWindowReport(
  collectionName: string,
  publishField: string,
  unpublishField: string,
  inverted: readonly InvertedWindowEntry[],
): string {
  const count = inverted.length;
  const headline =
    count === 1
      ? `Collection "${collectionName}": 1 entry has an unpublishField instant at or before its publishField instant`
      : `Collection "${collectionName}": ${String(count)} entries have an unpublishField instant at or before their publishField instant`;
  const detail = inverted
    .map(
      ({ entry, publishAt, unpublishAt }) =>
        `  ${printable(`/${entry.locale}/${entry.path}`)}: unpublishField "${unpublishField}" (${printable(unpublishAt)}) is at or before publishField "${publishField}" (${printable(publishAt)})`,
    )
    .join("\n");
  return `${headline} — ${INVERTED_WINDOW_FIX}:\n${detail}`;
}

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

// Decoded to decide, never to rewrite (#112). Run by run, so a stray `%` stays as written,
// and one pass, so an id named with a literal `%` is not refused.
function percentDecoded(value: string): string {
  return value.replace(ESCAPE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

// What the WHATWG URL parser removes wherever it sits.
const URL_STRIPPED = /[\t\n\r]/g;

// What the URL parser trims from either end.
const URL_TRIMMED = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

// `.%09./secret` resolves as `../secret`: the parser drops the tab before resolving (#141).
function urlParserReading(value: string): string {
  return value.replace(URL_STRIPPED, "").replace(URL_TRIMMED, "");
}

// `..` is refused as a substring: the field is not a path. Every spelling is read (raw,
// decoded, URL-parsed), because no reading covers another's loaders (#141).
function refusedFieldReasons(value: string): string[] {
  const written = [value, percentDecoded(value)];
  const spellings = [...written, ...written.map(urlParserReading)];
  const reasons: string[] = [];
  if (spellings.some((spelling) => spelling.includes("\0"))) {
    reasons.push("a NUL");
  }
  if (spellings.some((spelling) => spelling.includes("\\"))) {
    reasons.push("a backslash");
  }
  if (spellings.some((spelling) => spelling.startsWith("/"))) {
    reasons.push('a leading "/"');
  }
  if (spellings.some((spelling) => spelling.includes(".."))) {
    reasons.push('a ".."');
  }
  return reasons;
}

function describeReasons(reasons: string[]): string {
  if (reasons.length < 2) return reasons.join("");
  const last = reasons[reasons.length - 1];
  return `${reasons.slice(0, -1).join(", ")} and ${last}`;
}

// The one reading of "usable" both doors take (ADR-0004).
function unusableIdReason(id: EntryId): string | undefined {
  const localeReasons = refusedFieldReasons(id.locale);
  const pathReasons = refusedFieldReasons(id.path);
  const clauses: string[] = [];
  if (localeReasons.length > 0) {
    clauses.push(`its locale holds ${describeReasons(localeReasons)}`);
  }
  if (pathReasons.length > 0) {
    clauses.push(`its path holds ${describeReasons(pathReasons)}`);
  }
  return clauses.length === 0 ? undefined : clauses.join(", ");
}

const UNUSABLE_ID_FIX =
  'an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop';

// The whole sync fails, good rows and all: storing the well-keyed ones would advance the
// cursor past the rest.
function refuseUnusableIds<TIn>(
  collectionName: string,
  buffer: readonly BufferedWrite<TIn>[],
): void {
  const lines: string[] = [];
  for (const write of buffer) {
    if (write.kind !== "upsert") continue;
    const reason = unusableIdReason(write);
    if (reason === undefined) continue;
    lines.push(`  ${printable(`/${write.locale}/${write.path}`)}: ${reason}`);
  }
  if (lines.length === 0) return;
  const subject =
    lines.length === 1
      ? "1 entry does not"
      : `${String(lines.length)} entries do not`;
  throw new Error(
    `Collection "${collectionName}": ${subject} have a usable entry id — ${UNUSABLE_ID_FIX}:\n${lines.join("\n")}`,
  );
}

// A plain `Error`, exit 1: the id may come from CMS content, with nothing in the site to edit.
function refuseUnusableId(collection: string, id: EntryId): void {
  const reason = unusableIdReason(id);
  if (reason === undefined) return;
  throw new Error(
    `Collection "${collection}": entry id ${quoteIdentifier(`/${id.locale}/${id.path}`)} is not a usable identifier — ${reason} — ${UNUSABLE_ID_FIX}`,
  );
}

/**
 * Store-first; on a miss, caches what `fetchOne` returns once the schema accepts it.
 * The write-back takes no lock, so against a concurrent sync it is last-writer-wins.
 */
export async function getEntryCached<TOut, TIn = TOut>(
  store: ContentStore,
  collection: Collection<TOut, TIn>,
  id: EntryId,
): Promise<Entry<TOut> | undefined> {
  // Both refusals precede the store read: after a hit they would exempt every cached id.
  refuseAbsentSchema(collection);
  refuseUnusableId(collection.name, id);

  const stored = store.getEntry<TOut>(collection.name, id.locale, id.path);
  if (stored !== undefined) return stored;

  if (collection.loader.fetchOne === undefined) return undefined;

  let data: TIn | undefined;
  try {
    data = await collection.loader.fetchOne(id);
  } catch (error) {
    throw loaderFailed(collection.name, "fetchOne", error);
  }
  if (data === undefined) return undefined;

  // Validated before the write, and a failure throws: a silent drop reads as "no such entry".
  let validated: TOut;
  if (collection.schema === false) {
    validated = data as unknown as TOut;
  } else {
    const verdict = await validateEntry(collection.name, collection.schema, {
      locale: id.locale,
      path: id.path,
      data,
    });
    if (verdict.lines !== undefined) {
      throw schemaFailure(collection.name, 1, verdict.lines);
    }
    validated = verdict.value;
  }

  store.upsertEntry({
    collection: collection.name,
    locale: id.locale,
    path: id.path,
    data: validated,
  });
  return store.getEntry<TOut>(collection.name, id.locale, id.path);
}
