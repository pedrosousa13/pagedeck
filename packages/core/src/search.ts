import { ConfigError } from "./exit.js";
import { collisionLines, fileHash, fileKey } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";
import { quote } from "./quote.js";

export interface SearchDocument {
  readonly locale: string;
  readonly path: string;
  readonly domain?: string;
  readonly output: string;
  /** The page's rendered body, not the document the build wrapped around it. */
  readonly html: string;
  readonly title?: string;
}

export interface SearchAdapter {
  readonly name: string;
  index(
    documents: readonly SearchDocument[],
  ): readonly EmittedFile[] | Promise<readonly EmittedFile[]>;
  /**
   * The patched index must equal, byte for byte, what `index` returns over this
   * build's whole document set; `searchPatchFaults` checks it (#307).
   */
  patch?(input: SearchPatchInput): SearchPatch | Promise<SearchPatch>;
}

export interface SearchRemoval {
  readonly locale: string;
  readonly path: string;
  readonly domain?: string;
}

export interface SearchPatchInput {
  /** `contents` is always a `Uint8Array` here: it is read back off the tree. */
  readonly previous: readonly EmittedFile[];
  readonly documents: readonly SearchDocument[];
  readonly removed: readonly SearchRemoval[];
}

export interface SearchPatch {
  readonly written: readonly EmittedFile[];
  readonly pruned: readonly { readonly domain?: string; readonly path: string }[];
}

const SHAPE_FIX =
  'search: { name: "lunr", index: (documents) => [{ path: "/search-index.json", kind: "asset", contents }] }';
const NAME_FIX =
  'write the name this adapter is reported by, such as "lunr"';
const INDEX_FIX =
  'write the function this build hands its rendered pages to, as index: (documents) => [{ path: "/search-index.json", kind: "asset", contents }]';
const PATCH_FIX =
  'write the function this build hands the previous index and the pages that moved to, as patch: ({ previous, documents, removed }) => ({ written, pruned }), or remove "patch" so an incremental build renders every page for the index';

export function searchFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.search" must be an object with a name and an index function — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const faults: string[] = [];
  const name = read("name");
  if (typeof name !== "string" || name.trim() === "") {
    faults.push(`  "name" — ${quote(name)} — not an adapter name — ${NAME_FIX}`);
  }
  if (typeof read("index") !== "function") {
    faults.push(
      `  "index" — ${quote(read("index"))} — not an index function — ${INDEX_FIX}`,
    );
  }
  const patch = read("patch");
  if (patch !== undefined && typeof patch !== "function") {
    faults.push(
      `  "patch" — ${quote(patch)} — not a patch function — ${PATCH_FIX}`,
    );
  }
  if (faults.length === 0) return undefined;
  return `${where}: "build.search" declares ${String(faults.length)} ${
    faults.length === 1 ? "field" : "fields"
  } this build cannot index through — declare each as the type its own line names:\n${faults.join("\n")}`;
}

/**
 * Sorted although `collectPages` already sorts: an index's bytes must not
 * follow how pages were collected or rendered (spec §11).
 */
export function searchDocuments(
  rows: readonly { page: Page; html: string; title?: string }[],
): readonly SearchDocument[] {
  return rows
    .map(({ page, html, title }) => ({
      locale: page.locale,
      path: page.path,
      ...(page.domain === undefined ? {} : { domain: page.domain }),
      output: page.output,
      html,
      ...(title === undefined ? {} : { title }),
    }))
    .sort((a, b) =>
      a.locale === b.locale
        ? a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0
        : a.locale < b.locale
          ? -1
          : 1,
    );
}

export interface SearchInput {
  adapter: SearchAdapter;
  documents: readonly SearchDocument[];
  emitted: readonly EmittedFile[];
}

const COLLISION_FIX =
  'return each derived file at a path of the adapter\'s own, such as "/search-index.json"';
const CLAIM_FIX =
  "return each derived file with neither field, and link it from the site's own pages";

/**
 * Adds no `domain`: the adapter places its files per tree itself, unlike the
 * assets core composes (#415).
 */
export async function searchFiles(
  input: SearchInput,
): Promise<readonly EmittedFile[]> {
  let files: readonly EmittedFile[];
  try {
    files = await input.adapter.index(input.documents);
  } catch (cause) {
    throw new Error(
      `Search index: the ${JSON.stringify(input.adapter.name)} adapter threw while indexing ${String(input.documents.length)} document${input.documents.length === 1 ? "" : "s"} — "build.search" is the site's own indexer and is handed every page this build rendered; fix the adapter, or remove "build.search" until it indexes this site`,
      { cause },
    );
  }

  refuseReturned(input.adapter.name, files, input.emitted);
  return files;
}

function refuseReturned(
  name: string,
  files: readonly EmittedFile[],
  emitted: readonly EmittedFile[],
): void {
  const collisions = collisionLines(files, emitted);
  if (collisions.length > 0) {
    throw new ConfigError(
      `Search index: the ${JSON.stringify(name)} adapter returned ${String(collisions.length)} ${
        collisions.length === 1 ? "file" : "files"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the adapter is called; ${COLLISION_FIX}:\n${collisions.join("\n")}`,
    );
  }

  const claims = claimLines(files);
  if (claims.length > 0) {
    throw new ConfigError(
      `Search index: the ${JSON.stringify(name)} adapter returned ${String(claims.length)} ${
        claims.length === 1 ? "file" : "files"
      } claiming a page or a chunk of the client build — a "page" says a file is one page's own HTML and a "name" says which chunk of the client build it is, and the manifest answers a column of the document from each; ${CLAIM_FIX}:\n${claims.join("\n")}`,
    );
  }
}

export interface SearchPatchStageInput {
  adapter: SearchAdapter;
  previous: readonly EmittedFile[];
  documents: readonly SearchDocument[];
  removed: readonly SearchRemoval[];
  emitted: readonly EmittedFile[];
}

const PRUNE_FIX = "prune each file by the domain and path it was handed at";

export async function searchPatchFiles(
  input: SearchPatchStageInput,
): Promise<{ written: readonly EmittedFile[]; carried: readonly EmittedFile[] }> {
  const { adapter } = input;
  let patch: SearchPatch;
  try {
    // Checked at config load, so a declared `patch` is a function here; the
    // caller reaches this only for an adapter that declared one.
    patch = await (adapter.patch as NonNullable<SearchAdapter["patch"]>)({
      previous: input.previous,
      documents: input.documents,
      removed: input.removed,
    });
  } catch (cause) {
    const documents = input.documents.length;
    const removed = input.removed.length;
    throw new Error(
      `Search index: the ${JSON.stringify(adapter.name)} adapter threw while patching the index over ${String(documents)} document${documents === 1 ? "" : "s"} and ${String(removed)} removal${removed === 1 ? "" : "s"} — "build.search" is the site's own indexer and is handed the previous build's index and the pages that moved since; fix the adapter's patch, or run pagedeck build to index every page`,
      { cause },
    );
  }

  refuseReturned(adapter.name, patch.written, input.emitted);

  const held = new Set(
    input.previous.map((file) => fileKey(file.domain, file.path)),
  );
  const strays = patch.pruned
    .map((file) => fileKey(file.domain, file.path))
    .filter((key) => !held.has(key));
  if (strays.length > 0) {
    throw new ConfigError(
      `Search index: the ${JSON.stringify(adapter.name)} adapter pruned ${String(strays.length)} ${
        strays.length === 1 ? "file" : "files"
      } the previous build's index does not hold — a patch prunes only files its own previous index wrote, which it is handed as "previous"; ${PRUNE_FIX}:\n${strays
        .map((key) => `  ${JSON.stringify(key)}`)
        .join("\n")}`,
    );
  }

  return {
    written: patch.written,
    carried: carriedFiles(input.previous, patch),
  };
}

function carriedFiles(
  previous: readonly EmittedFile[],
  patch: SearchPatch,
): EmittedFile[] {
  const replaced = new Set(
    [...patch.written, ...patch.pruned].map((file) =>
      fileKey(file.domain, file.path),
    ),
  );
  return previous.filter(
    (file) => !replaced.has(fileKey(file.domain, file.path)),
  );
}

export async function searchPatchFaults(
  adapter: Required<SearchAdapter>,
  sets: {
    before: readonly SearchDocument[];
    after: readonly SearchDocument[];
  },
): Promise<string[]> {
  const identity = (one: SearchDocument): string =>
    `${one.locale} ${one.path}`;
  const before = new Map(sets.before.map((one) => [identity(one), one]));
  const after = new Map(sets.after.map((one) => [identity(one), one]));
  const same = (a: SearchDocument, b: SearchDocument): boolean =>
    a.locale === b.locale &&
    a.path === b.path &&
    a.domain === b.domain &&
    a.output === b.output &&
    a.html === b.html &&
    a.title === b.title;

  const previous = (await adapter.index(sets.before)).map(
    (file): EmittedFile => ({
      ...file,
      contents:
        typeof file.contents === "string"
          ? new TextEncoder().encode(file.contents)
          : file.contents,
    }),
  );
  const documents = sets.after.filter((one) => {
    const was = before.get(identity(one));
    return was === undefined || !same(was, one);
  });
  const removed = sets.before
    .filter((one) => {
      const now = after.get(identity(one));
      return now === undefined || now.domain !== one.domain;
    })
    .map(({ locale, path, domain }) => ({
      locale,
      path,
      ...(domain === undefined ? {} : { domain }),
    }));

  const patch = await adapter.patch({ previous, documents, removed });
  const patched = new Map(
    [...carriedFiles(previous, patch), ...patch.written].map((file) => [
      fileKey(file.domain, file.path),
      fileHash(file.contents),
    ]),
  );
  const full = new Map(
    (await adapter.index(sets.after)).map((file) => [
      fileKey(file.domain, file.path),
      fileHash(file.contents),
    ]),
  );

  return [...new Set([...patched.keys(), ...full.keys()])]
    .sort()
    .flatMap((key) => {
      const ours = patched.get(key);
      const theirs = full.get(key);
      if (ours === theirs) return [];
      const why =
        ours === undefined
          ? "a full index holds a file the patched index does not"
          : theirs === undefined
            ? "the patched index holds a file a full index does not"
            : "the patched index holds other bytes than a full index";
      return [`  ${JSON.stringify(key)} — ${why}`];
    });
}

function claimLines(files: readonly EmittedFile[]): string[] {
  return files.flatMap((file) => {
    const claimed = [
      ...(file.page === undefined ? [] : ['"page"']),
      ...(file.name === undefined ? [] : ['"name"']),
    ];
    return claimed.length === 0
      ? []
      : [
          `  ${JSON.stringify(fileKey(file.domain, file.path))} — sets ${claimed.join(" and ")}`,
        ];
  });
}
