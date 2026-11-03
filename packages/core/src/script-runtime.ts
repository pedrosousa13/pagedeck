import { ConfigError } from "./exit.js";
import { pageKey } from "./incremental.js";
import { textOf } from "./links.js";
import type { BrokenReference } from "./links.js";
import { localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { collisionLines, fileHash, shortHash } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import type { ScriptRuntimeAdapter, ScriptRuntimeFile } from "./scripts.js";

const SCRIPT_RUNTIME_DIR = "/script-runtime/";

const RUNTIME_HASH_LENGTH = 8;

/** A function of the files alone, so an adapter can name it before any build. */
export function scriptRuntimeBase(files: readonly ScriptRuntimeFile[]): string {
  const digest = shortHash(
    JSON.stringify(
      files.map(({ name, contents }) => [
        name,
        fileHash(contents).slice("sha256:".length),
      ]),
    ),
    RUNTIME_HASH_LENGTH,
  );
  return `${SCRIPT_RUNTIME_DIR}${digest}/`;
}

export function scriptRuntimeOutput(input: {
  runtime: ScriptRuntimeAdapter | undefined;
  locales: LocaleSet;
  emitted: readonly EmittedFile[];
}): EmittedFile[] {
  const declared = input.runtime?.files ?? [];
  if (declared.length === 0) return [];
  const base = scriptRuntimeBase(declared);
  const trees = new Set<string>();
  for (const locale of input.locales.values()) trees.add(localeTree(locale) ?? "");
  const placed = [...trees].sort().flatMap((domain) =>
    declared.map(({ name, contents }) => ({
      name,
      file: {
        ...(domain === "" ? {} : { domain }),
        path: `${base}${name}`,
        kind: "asset",
        hashed: true,
        contents,
      } satisfies EmittedFile,
    })),
  );
  const collisions = placed
    .flatMap(({ name, file }) =>
      collisionLines([file], input.emitted).map((line) =>
        line.replace(" — the build", ` — ${JSON.stringify(name)} — the build`),
      ),
    )
    .sort();
  if (collisions.length > 0) {
    throw new ConfigError(
      `Script runtime: "build.scripts.runtime" declares ${String(collisions.length)} ${
        collisions.length === 1 ? "file" : "files"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the runtime's files are; move the page off that address:\n${collisions.join("\n")}`,
    );
  }
  return placed.map(({ file }) => file);
}

/**
 * A text search, not a link check: Partytown's snippet names its directory
 * inside script text, where no attribute carries it (#275).
 */
export function movedRuntimeDirectories(input: {
  reused: readonly EmittedFile[];
  runtime: ScriptRuntimeAdapter | undefined;
  previous: readonly { path: string }[];
}): BrokenReference[] {
  const declared = input.runtime?.files ?? [];
  const kept = declared.length === 0 ? undefined : scriptRuntimeBase(declared);
  const gone = [
    ...new Set(
      input.previous
        .filter(({ path }) => path.startsWith(SCRIPT_RUNTIME_DIR))
        .map(({ path }) => path.slice(0, path.lastIndexOf("/") + 1)),
    ),
  ].filter((dir) => dir !== kept);
  if (gone.length === 0) return [];
  return input.reused.flatMap((file) => {
    if (file.kind !== "html" || file.page === undefined) return [];
    const text = textOf(file.contents);
    const href = gone.find((dir) => text.includes(dir));
    return href === undefined ? [] : [{ page: pageKey(file.page), href }];
  });
}
