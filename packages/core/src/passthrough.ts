import { relative, sep } from "node:path";
import { ConfigError } from "./exit.js";
import { pageKey } from "./incremental.js";
import { emittedKeys, referenceTargets, textOf } from "./links.js";
import { localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { collisionLines, fileKey } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import { refKey } from "./pages.js";
import type { Page, TrailingSlash } from "./pages.js";
import { quote } from "./quote.js";

export interface PassthroughSetting {
  readonly root?: string;
  readonly contentRoot?: string;
}

const SHAPE_FIX =
  'passthrough: { root: "./public" }, or passthrough: { contentRoot: "./src" }';
const ROOT_FIX =
  'point root at the directory whose files this build publishes, such as root: "./public"';
const CONTENT_ROOT_FIX =
  'point contentRoot at the content tree a page\'s content-relative references resolve into, such as contentRoot: "./src"';

export function passthroughFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.passthrough" must be an object naming the directory of files the site publishes whole, the content tree its pages' relative references resolve into, or both — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const root = Object.hasOwn(record, "root") ? record["root"] : undefined;
  const faults: string[] = [];
  if (root !== undefined && (typeof root !== "string" || root === "")) {
    faults.push(
      `  "root" — ${quote(root)} — not a path to the directory of files the site publishes — ${ROOT_FIX}`,
    );
  }
  const contentRoot = Object.hasOwn(record, "contentRoot")
    ? record["contentRoot"]
    : undefined;
  if (
    contentRoot !== undefined &&
    (typeof contentRoot !== "string" || contentRoot === "")
  ) {
    faults.push(
      `  "contentRoot" — ${quote(contentRoot)} — not a path to the content tree a page's content-relative references resolve into — ${CONTENT_ROOT_FIX}`,
    );
  }
  if (root === undefined && contentRoot === undefined) {
    return `${where}: "build.passthrough" declares neither root nor contentRoot, so it publishes nothing — declare root as the directory of files the site publishes whole, such as root: "./public", declare contentRoot as the content tree its pages' relative references resolve into, such as contentRoot: "./src", or remove passthrough`;
  }
  if (faults.length === 0) return undefined;
  return `${where}: "build.passthrough" declares ${String(faults.length)} ${
    faults.length === 1 ? "field" : "fields"
  } this build cannot publish the site's own files from — declare each as the type its own line names:\n${faults.join("\n")}`;
}

export interface PassthroughSource {
  readonly src: string;
  readonly bytes: Uint8Array;
}

export interface PassthroughInput {
  readonly field: "root" | "contentRoot";
  readonly root: string;
  readonly files: readonly PassthroughSource[];
  readonly locales: LocaleSet;
  readonly emitted: readonly EmittedFile[];
}

export function passthroughAddress(root: string, src: string): string {
  return `/${relative(root, src).split(sep).join("/")}`;
}

export interface ContentRelativeReference {
  readonly entry?: string;
  readonly page: string;
  readonly href: string;
  readonly address: string;
}

export interface ContentRelativeReferenceInput {
  readonly documents: readonly EmittedFile[];
  readonly emitted: readonly EmittedFile[];
  readonly pages: readonly Page[];
  readonly trailingSlash: TrailingSlash;
}

export function contentRelativeReferences(
  input: ContentRelativeReferenceInput,
): readonly ContentRelativeReference[] {
  const emitted = emittedKeys(input.emitted);
  const entries = new Map(
    input.pages.map((page) => [pageKey(page), entryOf(page)] as const),
  );
  const found = new Map<string, ContentRelativeReference>();
  for (const file of input.documents) {
    if (file.kind !== "html") continue;
    const base = documentBase(file.path, input.trailingSlash);
    const page = file.page === undefined ? file.path : pageKey(file.page);
    const entry = entries.get(page);
    for (const { reference, target } of referenceTargets(
      textOf(file.contents),
    )) {
      if (reference.kind !== "asset" || target.at !== "relative") continue;
      const address = resolveAgainst(base, target.href);
      if (emitted.has(fileKey(file.domain, address))) continue;
      if (found.has(address)) continue;
      found.set(address, {
        ...(entry === undefined ? {} : { entry }),
        page,
        href: reference.url,
        address,
      });
    }
  }
  return [...found.values()].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
}

function entryOf(page: Page): string | undefined {
  const { collection, entry } = page;
  if (collection === undefined || entry === undefined) return undefined;
  return refKey({ collection, locale: entry.locale, path: entry.path });
}

function documentBase(path: string, trailingSlash: TrailingSlash): string {
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  if (trailingSlash === "always" || directory === "/") return directory;
  const address = directory.slice(0, -1);
  return address.slice(0, address.lastIndexOf("/") + 1);
}

/**
 * RFC 3986 §5.2: a `..` with nothing left to pop is dropped, so no reference
 * resolves outside the content tree.
 */
function resolveAgainst(base: string, href: string): string {
  const segments = base.split("/").filter((segment) => segment !== "");
  for (const segment of href.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

const COLLISION_FIX: Readonly<Record<PassthroughInput["field"], string>> = {
  root: 'move the page off that address, or take the file out of the directory "build.passthrough.root" names',
  contentRoot:
    'point the reference that resolves there at another file beneath the directory "build.passthrough.contentRoot" names, one at an address no output tree already holds, or have every output tree emit a file at that address',
};

export function passthroughFiles(
  input: PassthroughInput,
): readonly EmittedFile[] {
  // `""`, not `undefined`: `sort` moves `undefined` last without calling the
  // comparator.
  const trees = new Set<string>();
  for (const locale of input.locales.values()) {
    trees.add(localeTree(locale) ?? "");
  }
  const domains = [...trees].sort();

  const inTree = input.files
    .map((file) => ({
      path: passthroughAddress(input.root, file.src),
      // `asset` whatever the extension: a site's own `.js` is no chunk a page's
      // budget pays for.
      kind: "asset" as const,
      contents: file.bytes,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files: EmittedFile[] = domains.flatMap((domain) =>
    inTree.map((file) => ({
      ...(domain === "" ? {} : { domain }),
      ...file,
    })),
  );

  const collisions = collisionLines(files, input.emitted);
  if (collisions.length > 0) {
    throw new ConfigError(
      `Passthrough: ${String(collisions.length)} ${
        collisions.length === 1 ? "file is" : "files are"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and the files this build composes are all written first; ${COLLISION_FIX[input.field]}:\n${collisions.join("\n")}`,
    );
  }
  return files;
}
