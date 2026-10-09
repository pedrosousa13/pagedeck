import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { EntryId, Loader, SyncResult } from "@pagedeck/content";
import { parseFrontmatter } from "./frontmatter.js";
import type { FrontmatterValue } from "./frontmatter.js";
import { createMarkdownRenderer } from "./render.js";
import type { MarkdownRenderer, RenderedMarkdown } from "./render.js";
import type { BundledLanguage, BundledTheme } from "shiki";

export interface MarkdownEntry {
  /** The declared fields as text, unread beyond `title`; the schema says what they mean. */
  readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  /**
   * Frontmatter `title`, else the first level-1 heading, which leaves the body either way.
   * A file with neither is refused, naming both ways to supply one.
   */
  readonly title: string;
  readonly html: string;
  /** Stored so a template never re-derives a slug from the markup. */
  readonly toc: RenderedMarkdown["toc"];
  /** Relative to the root, POSIX-spelled: the entry's `path` plus `.md`. */
  readonly file: string;
}

export interface MarkdownLoaderOptions {
  /** Absolute, or relative to the working directory: resolve it against the config's own file. */
  readonly root: string;
  readonly locale: string;
  /** Declared, not discovered: a fence naming any other language is refused. */
  readonly languages: readonly BundledLanguage[];
  /** A theme, or a light and dark pair whose dark colours the site's own stylesheet switches on. */
  readonly theme?:
    | BundledTheme
    | { readonly light: BundledTheme; readonly dark: BundledTheme };
  /** Curl straight quotes in prose; off unless named. */
  readonly smartQuotes?: boolean;
}

const EXTENSION = ".md";

interface Found {
  file: string;
  absolute: string;
  modified: number;
}

// Sorted per directory: `readdirSync` order varies by filesystem, and row `seq`s must not.
// Anything that is neither a directory nor a `.md` file is skipped.
function walk(root: string, directory: string, found: Found[]): void {
  for (const dirent of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )) {
    const absolute = join(directory, dirent.name);
    if (dirent.isDirectory()) {
      walk(root, absolute, found);
      continue;
    }
    if (!dirent.isFile() || !dirent.name.endsWith(EXTENSION)) continue;
    found.push({
      file: relative(root, absolute).split(sep).join(posix.sep),
      absolute,
      modified: Math.floor(statSync(absolute).mtimeMs),
    });
  }
}

// A missing root would sync as an empty tree. A plain `Error`, exit 1: a directory absent
// from a checkout comes right on the next run with no edit.
function refuseMissingRoot(root: string): void {
  let directory = false;
  try {
    directory = statSync(root).isDirectory();
  } catch {
    directory = false;
  }
  if (directory) return;
  throw new Error(
    `Markdown root "${root}": is not a directory, so the collection would sync as empty — point the loader at the directory the markdown lives in`,
  );
}

const LANGUAGES_FIX =
  "pass languages: [...] naming the code-fence languages the site uses, or [] for none";

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "function") return "a function";
  if (typeof value === "object" && value !== null) return "an object";
  return String(value);
}

function refuseUnusableLanguages(root: string, languages: unknown): void {
  const prefix = `Markdown root "${root}":`;
  if (languages === undefined) {
    throw new Error(`${prefix} the loader has no "languages" option — ${LANGUAGES_FIX}`);
  }
  if (!Array.isArray(languages)) {
    throw new Error(
      `${prefix} the loader's "languages" option is ${describe(languages)}, not a list — ${LANGUAGES_FIX}`,
    );
  }
  const faults = languages.flatMap((language: unknown, index) =>
    typeof language === "string"
      ? []
      : [`languages[${String(index)}] is ${describe(language)}, not a string`],
  );
  if (faults.length === 0) return;
  const subject =
    faults.length === 1
      ? `1 entry of the loader's "languages" option is not a language name`
      : `${String(faults.length)} entries of the loader's "languages" option are not language names`;
  throw new Error(
    `${prefix} ${subject} — ${LANGUAGES_FIX}:\n${faults.map((fault) => `  ${fault}`).join("\n")}`,
  );
}

function untitledMessage(file: string): string {
  return `Markdown "${file}": has no title — give it a "title" in its frontmatter, or open it with a level-1 heading that has text`;
}

// One report over the whole tree, every kind of failure alike (rule 5).
function refuseUnreadable(root: string, faults: readonly string[]): void {
  if (faults.length === 0) return;
  const subject =
    faults.length === 1
      ? "1 document could not be read"
      : `${String(faults.length)} documents could not be read`;
  const detail = faults
    .map((message) =>
      message
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
    .join("\n");
  throw new Error(
    `Markdown root "${root}": ${subject}, and each failure below carries its own fix:\n${detail}`,
  );
}

function pathOf(file: string): string {
  return file.slice(0, -EXTENSION.length);
}

// Broad catch: a file deleted between the walk and the read is that file's failure too.
async function read(
  found: Found,
  renderer: MarkdownRenderer,
): Promise<MarkdownEntry | { fault: string }> {
  try {
    return await readOne(found, renderer);
  } catch (cause) {
    return {
      fault: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function readOne(
  found: Found,
  renderer: MarkdownRenderer,
): Promise<MarkdownEntry | { fault: string }> {
  const source = readFileSync(found.absolute, "utf8");
  const { frontmatter, body } = parseFrontmatter(source, found.file);
  return renderer.render(body, found.file).then((rendered) => {
    const declared = frontmatter["title"];
    // A list-valued `title` is not a title: this loader parses no types.
    const title =
      typeof declared === "string" && declared !== ""
        ? declared
        : rendered.title;
    if (title === undefined) return { fault: untitledMessage(found.file) };
    return {
      frontmatter,
      title,
      html: rendered.html,
      toc: rendered.toc,
      file: found.file,
    };
  });
}

// The walk's start, not the newest mtime seen: a file written mid-walk is re-read next time
// rather than skipped forever. Floored, since `mtimeMs` can be fractional.
function cursorFor(startedAt: number): number {
  return Math.floor(startedAt);
}

// An incremental sync walks the whole tree too; it saves the reading and highlighting.
async function sync(
  options: MarkdownLoaderOptions,
  renderer: () => Promise<MarkdownRenderer>,
  writer: { upsert(entry: { locale: string; path: string; data: MarkdownEntry }): void },
  select: (found: Found) => boolean,
  authoritative: boolean,
): Promise<SyncResult> {
  const startedAt = Date.now();
  refuseMissingRoot(options.root);

  const found: Found[] = [];
  walk(options.root, options.root, found);

  const changed: EntryId[] = [];
  const faults: string[] = [];
  for (const file of found) {
    if (!select(file)) continue;
    const entry = await read(file, await renderer());
    if ("fault" in entry) {
      faults.push(entry.fault);
      continue;
    }
    const id = { locale: options.locale, path: pathOf(file.file) };
    writer.upsert({ ...id, data: entry });
    changed.push(id);
  }
  // After the whole walk: `runSync` applies nothing when the loader throws.
  refuseUnreadable(options.root, faults);

  return {
    changed,
    // A deleted file leaves nothing to walk; `authoritative` reports removals instead.
    deleted: [],
    authoritative,
    cursor: cursorFor(startedAt),
  };
}

/** No `fetchOne`: a miss in a local directory means the file is not there. */
export function defineMarkdownLoader(
  options: MarkdownLoaderOptions,
): Loader<MarkdownEntry> {
  refuseUnusableLanguages(options.root, options.languages);
  // Lazy, so an incremental sync over an unchanged tree loads no grammar; the promise is kept
  // so concurrent syncs share one load.
  let loading: Promise<MarkdownRenderer> | undefined;
  const renderer = (): Promise<MarkdownRenderer> => {
    loading ??= createMarkdownRenderer({
      languages: options.languages,
      ...(options.theme === undefined ? {} : { theme: options.theme }),
      ...(options.smartQuotes === undefined
        ? {}
        : { smartQuotes: options.smartQuotes }),
    });
    return loading;
  };

  return {
    syncAll(writer) {
      return sync(options, renderer, writer, () => true, true);
    },
    syncSince(writer, cursor) {
      // Not authoritative: a delta says nothing about the rest of the tree.
      return sync(
        options,
        renderer,
        writer,
        (found) => found.modified >= cursor,
        false,
      );
    },
  };
}
