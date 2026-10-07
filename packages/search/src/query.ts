// No React and no DOM, reached via `@pagedeck/search/query`: the package index must not carry a
// browser runtime into `pagedeck build` (`index.test.ts`).
import { FIELD } from "./fields.js";
import { tokenize } from "./tokens.js";

// Spelled here, not imported: `src/shards.ts` reaches `@pagedeck/core`.
const READS_FORMAT = 1;

// A weighted term-frequency sum, not BM25: the format carries no corpus statistics. The
// weights are ordinal, so a title hit outranks nine body mentions.
const WEIGHT: Readonly<Record<number, number>> = {
  [FIELD.title]: 10,
  [FIELD.heading]: 4,
  [FIELD.body]: 1,
};

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type SearchFetch = (url: string) => Promise<FetchResponse>;

interface ShardRange {
  readonly file: string;
  readonly first: string;
  readonly last: string;
}

interface IndexMetadata {
  readonly format: number;
  readonly documents: string;
  readonly shards: readonly ShardRange[];
}

interface DocumentRecord {
  readonly path: string;
  readonly output: string;
  readonly title?: string;
}

interface Posting {
  readonly d: number;
  readonly f: number;
  readonly w: number;
}

type ShardEntry = readonly [string, readonly Posting[]];

export interface SearchHit {
  /** The page's path, as the build routed it. Its identity, not its address. */
  readonly path: string;
  /** The URL to link to, never `path`: on a prefixed locale the two differ (#88). */
  readonly output: string;
  readonly title?: string;
  /** What the ranking above scored it. Comparable within one result set only. */
  readonly score: number;
}

export interface SearchClientOptions {
  /** Which locale's index to read: the directory under `search/`. */
  readonly locale: string;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: SearchFetch;
}

export interface SearchClient {
  /** Fetches only the metadata, which the island calls on focus. */
  warm(): Promise<void>;
  search(query: string): Promise<readonly SearchHit[]>;
}

// Declared here, not via the `DOM` lib. Read at call time, so a `fetch` installed after this
// module loaded is used.
interface Browser {
  fetch?: SearchFetch;
}

export function createSearchClient(options: SearchClientOptions): SearchClient {
  const directory = `/search/${options.locale}`;
  const fetched = new Map<string, Promise<unknown>>();
  let metadata: Promise<IndexMetadata> | undefined;
  let documents: Promise<readonly DocumentRecord[]> | undefined;

  // Caches the promise, so concurrent keystrokes share a request, and keeps a rejection, so a
  // missing file is not refetched per letter.
  const file = async (name: string): Promise<unknown> => {
    const url = `${directory}/${name}`;
    let pending = fetched.get(url);
    if (pending === undefined) {
      pending = (async () => {
        const fetcher =
          options.fetch ?? (globalThis as Browser).fetch ?? refuseNoFetch();
        const response = await fetcher(url);
        if (!response.ok) {
          throw new Error(
            `Search index "${url}": the request failed with status ${String(response.status)}, so this query cannot be answered — check that the build wrote a search index for locale "${options.locale}" and that it was deployed with the pages`,
          );
        }
        return response.json();
      })();
      fetched.set(url, pending);
    }
    return pending;
  };

  const loadMetadata = async (): Promise<IndexMetadata> => {
    metadata ??= (async () => {
      const read = (await file("index.json")) as IndexMetadata;
      refuseUnreadableFormat(read.format, `${directory}/index.json`);
      return read;
    })();
    return metadata;
  };

  const loadDocuments = async (
    read: IndexMetadata,
  ): Promise<readonly DocumentRecord[]> => {
    documents ??= file(read.documents) as Promise<readonly DocumentRecord[]>;
    return documents;
  };

  return {
    warm: async () => {
      await loadMetadata();
    },
    search: async (query: string) => {
      const terms = tokenize(query);
      if (terms.length === 0) return [];
      const read = await loadMetadata();

      // The last term is still being typed, so it matches by prefix; the rest match exactly.
      const scored = await Promise.all(
        terms.map(async (term, position) =>
          scoreTerm(read, term, position === terms.length - 1, file),
        ),
      );

      const [first, ...rest] = scored as [
        Map<number, number>,
        ...Map<number, number>[],
      ];
      const totals = new Map(first);
      for (const term of rest) {
        for (const [id, running] of totals) {
          const score = term.get(id);
          if (score === undefined) totals.delete(id);
          else totals.set(id, running + score);
        }
      }
      if (totals.size === 0) return [];

      const records = await loadDocuments(read);
      return [...totals]
        // Ties broken by document id, which is path order.
        .sort(([leftId, left], [rightId, right]) =>
          right === left ? leftId - rightId : right - left,
        )
        .flatMap(([id, score]) => {
          const record = records[id];
          if (record === undefined) return [];
          return [
            {
              path: record.path,
              output: record.output,
              ...(record.title === undefined ? {} : { title: record.title }),
              score,
            },
          ];
        });
    },
  };
}

async function scoreTerm(
  metadata: IndexMetadata,
  term: string,
  prefix: boolean,
  file: (name: string) => Promise<unknown>,
): Promise<Map<number, number>> {
  const scores = new Map<number, number>();
  const shards = await Promise.all(
    metadata.shards
      .filter((shard) => holds(shard, term, prefix))
      .map(async (shard) => (await file(shard.file)) as readonly ShardEntry[]),
  );
  for (const entries of shards) {
    for (const [, postings] of matches(entries, term, prefix)) {
      for (const posting of postings) {
        scores.set(posting.d, (scores.get(posting.d) ?? 0) + score(posting));
      }
    }
  }
  return scores;
}

// Code-unit `<` and `>`, as `shards.ts` sorted; `localeCompare` would read the host's ICU
// tables.
function holds(shard: ShardRange, term: string, prefix: boolean): boolean {
  if (!prefix) return shard.first <= term && term <= shard.last;
  return shard.last >= term && (shard.first <= term || shard.first.startsWith(term));
}

function matches(
  entries: readonly ShardEntry[],
  term: string,
  prefix: boolean,
): ShardEntry[] {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((entries[middle] as ShardEntry)[0] < term) low = middle + 1;
    else high = middle;
  }
  if (!prefix) {
    const found = entries[low];
    return found !== undefined && found[0] === term ? [found] : [];
  }
  const found: ShardEntry[] = [];
  for (let at = low; at < entries.length; at += 1) {
    const entry = entries[at] as ShardEntry;
    if (!entry[0].startsWith(term)) break;
    found.push(entry);
  }
  return found;
}

function score(posting: Posting): number {
  let weight = 0;
  for (const field of [FIELD.title, FIELD.heading, FIELD.body]) {
    if ((posting.w & field) !== 0) weight += WEIGHT[field] ?? 0;
  }
  return posting.f * weight;
}

// Older and newer are two messages because they are two fixes: rebuild the page or the index.
function refuseUnreadableFormat(format: number, where: string): void {
  if (format === READS_FORMAT) return;
  const reads = String(READS_FORMAT);
  throw new Error(
    format > READS_FORMAT
      ? `Search index "${where}": format ${String(format)} is newer than this query runtime reads (${reads}) — the index was written by a newer @pagedeck/search than the page querying it, so the page is the stale half; rebuild and redeploy the site so the page ships the @pagedeck/search that wrote this index`
      : `Search index "${where}": format ${String(format)} is older than this query runtime reads (${reads}) — the index was written by an older @pagedeck/search than the page querying it, so the index is the stale half; rebuild the site so the index is written by the @pagedeck/search this page ships`,
  );
}

function refuseNoFetch(): never {
  throw new Error(
    "Search query runtime: this environment has no global fetch, so no index file can be requested — pass a fetch to createSearchClient",
  );
}
