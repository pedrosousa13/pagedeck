// Writes the format `packages/search/README.md` documents, which `src/query.ts` reads:
// change a key in both.

import { ConfigError, fileKey } from "@pagedeck/core";
import type {
  EmittedFile,
  SearchDocument,
  SearchPatch,
  SearchPatchInput,
} from "@pagedeck/core";
import { FIELD } from "./fields.js";
import { extractText } from "./text.js";
import { tokenize } from "./tokens.js";

export const INDEX_FORMAT = 1;

// Bytes, not characters: a non-Latin term costs more per character on the wire. A term
// whose postings exceed the cap gets a shard to itself, since a term is never split.
const SHARD_CAP = 64 * 1024;

/**
 * What one keystroke may fetch: two straddled shards plus `index.json` and `documents.json`.
 * Not enforced at build time (#457); test suites measure built indexes against it.
 */
export const QUERY_CAP = 2 * SHARD_CAP + 16 * 1024;

interface Occurrences {
  frequency: number;
  fields: number;
}

interface Posting {
  readonly d: number;
  readonly f: number;
  readonly w: number;
}

interface DocumentRecord {
  readonly path: string;
  readonly output: string;
  readonly title?: string;
}

function unusableLocale(locale: string): string | undefined {
  if (locale === "") return "the locale is empty";
  if (locale === "." || locale === "..") {
    return "the locale is a dot segment, which resolves out of the search directory";
  }
  if (locale.includes("/")) {
    return 'the locale holds "/", which would write the shards into another directory';
  }
  return undefined;
}

function localeFaultReport(faults: readonly [string, string][]): string {
  const subject =
    faults.length === 1
      ? "1 locale is not a path segment"
      : `${String(faults.length)} locales are not path segments`;
  const detail = faults
    .map(([locale, reason]) => `  "${locale}" — ${reason}`)
    .join("\n");
  return `Search index: ${subject}, and each locale's shards are written under "/search/<locale>/" — declare each locale the way a path spells one, such as "pt-BR":\n${detail}`;
}

// Never `localeCompare`: it reads the host's ICU tables, so shard boundaries would vary by
// machine.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shardName(index: number): string {
  return `terms-${String(index).padStart(4, "0")}.json`;
}

interface Group {
  readonly domain: string | undefined;
  readonly locale: string;
  readonly documents: readonly SearchDocument[];
}

// Sorting each group is the determinism: an id is a position here. A shared path breaks the
// tie on `output` rather than being refused.
function group(documents: readonly SearchDocument[]): Group[] {
  const groups = new Map<string, SearchDocument[]>();
  for (const document of documents) {
    // NUL-joined, so no domain and locale can spell another pair's key.
    const key = `${document.domain ?? ""}\u0000${document.locale}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [document]);
    else existing.push(document);
  }
  return [...groups.values()].map((members) => {
    const first = members[0] as SearchDocument;
    return {
      domain: first.domain,
      locale: first.locale,
      documents: [...members].sort(
        (a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.output, b.output),
      ),
    };
  });
}

function count(
  table: Map<string, Occurrences>,
  text: string,
  field: number,
): void {
  for (const term of tokenize(text)) {
    let occurrences = table.get(term);
    if (occurrences === undefined) {
      occurrences = { frequency: 0, fields: 0 };
      table.set(term, occurrences);
    }
    occurrences.frequency += 1;
    occurrences.fields |= field;
  }
}

// A document's whole contribution, readable back from the files, so a patch can rebuild a
// directory without its unchanged pages (#307).
interface Member {
  readonly record: DocumentRecord;
  readonly table: ReadonlyMap<string, Occurrences>;
}

function memberOf(document: SearchDocument): Member {
  const { sections } = extractText(document.html);
  const table = new Map<string, Occurrences>();
  if (document.title !== undefined) {
    count(table, document.title, FIELD.title);
  }
  for (const section of sections) {
    if (section.heading !== null) {
      count(table, section.heading.text, FIELD.heading);
    }
    count(table, section.text, FIELD.body);
  }
  return {
    record: {
      path: document.path,
      output: document.output,
      ...(document.title === undefined ? {} : { title: document.title }),
    },
    table,
  };
}

function byRecord(a: Member, b: Member): number {
  return (
    byCodeUnit(a.record.path, b.record.path) ||
    byCodeUnit(a.record.output, b.record.output)
  );
}

function filesOfGroup({ domain, locale, documents }: Group): EmittedFile[] {
  return filesOfMembers(domain, locale, documents.map(memberOf));
}

// The one writer of a directory, for counted and read-back members alike.
function filesOfMembers(
  domain: string | undefined,
  locale: string,
  members: readonly Member[],
): EmittedFile[] {
  const records: DocumentRecord[] = [];
  const index = new Map<string, Map<number, Occurrences>>();

  members.forEach(({ record, table }, id) => {
    records.push(record);
    for (const [term, occurrences] of table) {
      let postings = index.get(term);
      if (postings === undefined) {
        postings = new Map();
        index.set(term, postings);
      }
      postings.set(id, occurrences);
    }
  });

  const terms = [...index.keys()].sort(byCodeUnit);
  const shards: { file: string; first: string; last: string }[] = [];
  const files: EmittedFile[] = [];
  let entries: string[] = [];
  let size = 0;
  let first = "";
  let last = "";

  const flush = (): void => {
    if (entries.length === 0) return;
    const file = shardName(shards.length);
    shards.push({ file, first, last });
    files.push({
      ...(domain === undefined ? {} : { domain }),
      path: `/search/${locale}/${file}`,
      kind: "asset",
      contents: `[${entries.join(",")}]`,
    });
    entries = [];
    size = 0;
  };

  for (const term of terms) {
    // Ascending by construction: documents are walked in id order.
    const postings: Posting[] = [
      ...(index.get(term) as Map<number, Occurrences>).entries(),
    ].map(([d, { frequency, fields }]) => ({ d, f: frequency, w: fields }));
    const entry = JSON.stringify([term, postings]);
    const cost = new TextEncoder().encode(entry).length + 1;
    // A term is appended whatever its size, so one larger than the cap sits alone in its shard.
    if (size + cost > SHARD_CAP) flush();
    if (entries.length === 0) first = term;
    last = term;
    entries.push(entry);
    size += cost;
  }
  flush();

  const metadata = {
    format: INDEX_FORMAT,
    locale,
    documents: "documents.json",
    shards,
  };
  files.push({
    ...(domain === undefined ? {} : { domain }),
    path: `/search/${locale}/documents.json`,
    kind: "asset",
    contents: JSON.stringify(records),
  });
  files.push({
    ...(domain === undefined ? {} : { domain }),
    path: `/search/${locale}/index.json`,
    kind: "asset",
    contents: JSON.stringify(metadata),
  });
  return files;
}

/** Pure: the same documents in any order produce the same bytes (spec §11). */
export function indexDocuments(
  documents: readonly SearchDocument[],
): EmittedFile[] {
  refuseLocales(documents);
  return group(documents).flatMap(filesOfGroup).sort(byFile);
}

function byFile(a: EmittedFile, b: EmittedFile): number {
  return (
    byCodeUnit(a.domain ?? "", b.domain ?? "") || byCodeUnit(a.path, b.path)
  );
}

function refuseLocales(documents: readonly SearchDocument[]): void {
  const faults = new Map<string, string>();
  for (const { locale } of documents) {
    const reason = unusableLocale(locale);
    if (reason !== undefined) faults.set(locale, reason);
  }
  if (faults.size > 0) {
    throw new ConfigError(
      localeFaultReport(
        [...faults.entries()].sort(([a], [b]) => byCodeUnit(a, b)),
      ),
    );
  }
}

function directoryKey(domain: string | undefined, locale: string): string {
  return `${domain ?? ""}\u0000${locale}`;
}

function textOf(file: EmittedFile): string {
  return typeof file.contents === "string"
    ? file.contents
    : new TextDecoder().decode(file.contents);
}

function membersOf(
  files: ReadonlyMap<string, EmittedFile>,
  directory: string,
): Member[] {
  // Total: `refuseUnreadable` has refused an index whose metadata names a missing file.
  const read = <T>(name: string): T =>
    JSON.parse(textOf(files.get(`${directory}${name}`) as EmittedFile)) as T;
  const metadata = read<{
    documents: string;
    shards: readonly { file: string }[];
  }>("index.json");
  const records = read<DocumentRecord[]>(metadata.documents);
  const tables = records.map(() => new Map<string, Occurrences>());
  for (const { file } of metadata.shards) {
    for (const [term, postings] of read<[string, Posting[]][]>(file)) {
      for (const { d, f, w } of postings) {
        tables[d]?.set(term, { frequency: f, fields: w });
      }
    }
  }
  return records.map((record, id) => ({
    record: {
      path: record.path,
      output: record.output,
      ...(record.title === undefined ? {} : { title: record.title }),
    },
    table: tables[id] as Map<string, Occurrences>,
  }));
}

function refuseUnreadable(previous: readonly EmittedFile[]): void {
  const held = new Set(previous.map((file) => fileKey(file.domain, file.path)));
  const faults: [string, string][] = [];
  for (const file of previous) {
    if (!file.path.startsWith("/search/") || !file.path.endsWith("/index.json")) {
      continue;
    }
    const key = fileKey(file.domain, file.path);
    const metadata = JSON.parse(textOf(file)) as {
      format: unknown;
      documents: string;
      shards: readonly { file: string }[];
    };
    if (metadata.format !== INDEX_FORMAT) {
      faults.push([
        key,
        `is format ${String(metadata.format)}, and this @pagedeck/search writes format ${String(INDEX_FORMAT)}`,
      ]);
      continue;
    }
    const directory = file.path.slice(0, -"index.json".length);
    const missing = [
      metadata.documents,
      ...metadata.shards.map((shard) => shard.file),
    ].filter((name) => !held.has(fileKey(file.domain, `${directory}${name}`)));
    for (const name of missing) {
      faults.push([
        key,
        `names ${JSON.stringify(name)}, and the previous index holds no such file`,
      ]);
    }
  }
  if (faults.length === 0) return;
  faults.sort(([a], [b]) => byCodeUnit(a, b));
  throw new ConfigError(
    `Search index: the previous index cannot be patched, for ${String(faults.length)} ${
      faults.length === 1 ? "reason" : "reasons"
    } — a patch reads each directory back out of its previous files, so every one has to be this format and whole; run pagedeck build to write the whole index again:\n${faults
      .map(([key, reason]) => `  ${JSON.stringify(key)} ${reason}`)
      .join("\n")}`,
  );
}

/**
 * Rewrites whole each directory (one locale, one tree) holding a moved page: ids are
 * positions, so nothing smaller is correct. Other directories are left as the tree holds them.
 */
export function patchDocuments(input: SearchPatchInput): SearchPatch {
  refuseLocales(input.documents);
  refuseUnreadable(input.previous);

  const moved = new Map<string, Group>();
  for (const members of group(input.documents)) {
    moved.set(directoryKey(members.domain, members.locale), members);
  }
  const removedPaths = new Map<string, Set<string>>();
  const dirty = new Map<string, { domain: string | undefined; locale: string }>();
  for (const { domain, locale } of moved.values()) {
    dirty.set(directoryKey(domain, locale), { domain, locale });
  }
  for (const { domain, locale, path } of input.removed) {
    const key = directoryKey(domain, locale);
    dirty.set(key, { domain, locale });
    const paths = removedPaths.get(key) ?? new Set<string>();
    paths.add(path);
    removedPaths.set(key, paths);
  }

  const written: EmittedFile[] = [];
  const pruned: { domain?: string; path: string }[] = [];
  for (const [key, { domain, locale }] of dirty) {
    const directory = `/search/${locale}/`;
    const tree = domain ?? "";
    const own = new Map(
      input.previous
        .filter(
          (file) =>
            (file.domain ?? "") === tree && file.path.startsWith(directory),
        )
        .map((file) => [file.path, file]),
    );
    const rendered = moved.get(key)?.documents ?? [];
    const gone = new Set([
      ...(removedPaths.get(key) ?? []),
      ...rendered.map((document) => document.path),
    ]);
    const members = [
      ...(own.has(`${directory}index.json`)
        ? membersOf(own, directory).filter(
            (member) => !gone.has(member.record.path),
          )
        : []),
      ...rendered.map(memberOf),
    ].sort(byRecord);

    const files =
      members.length === 0 ? [] : filesOfMembers(domain, locale, members);
    written.push(...files);
    const kept = new Set(files.map((file) => file.path));
    for (const path of own.keys()) {
      if (kept.has(path)) continue;
      pruned.push({ ...(domain === undefined ? {} : { domain }), path });
    }
  }

  return {
    written: written.sort(byFile),
    pruned: pruned.sort(
      (a, b) =>
        byCodeUnit(a.domain ?? "", b.domain ?? "") ||
        byCodeUnit(a.path, b.path),
    ),
  };
}
