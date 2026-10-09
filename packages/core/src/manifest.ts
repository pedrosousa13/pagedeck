import { createHash } from "node:crypto";
import type { EntryComponent, EntryPlan, PageEntry } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { FoldAdjustment } from "./fold.js";
import { pageKey } from "./incremental.js";
import type { EntryRef, Page, TrailingSlash } from "./pages.js";
import { quoteIdentifier } from "./quote.js";
import type {
  HeaderField,
  HeaderRule,
  ResolvedExperiment,
  ResolvedRedirect,
  RoutingManifest,
  RoutingTree,
  WeightedVariant,
} from "./routing.js";
import type {
  TierAssignment,
  TierGroup,
  TierPlan,
  TierPolicy,
} from "./tiers.js";

/**
 * When to bump, and why each version did:
 * `docs/adr/0008-when-the-manifest-version-moves.md`.
 */
export const MANIFEST_VERSION = 11;

/**
 * Here, not in `build.ts`: `pagedeck rollback` reads it, and `build.ts` imports the
 * bundler.
 */
export const MANIFEST_FILE = "manifest.json";

export interface BuildStamp {
  id: string;
  createdAt: string;
  parent?: string;
}

export interface StorePosition {
  seq: number;
}

export interface SiteFacts {
  trailingSlash: TrailingSlash;
}

export type FileKind = "html" | "js" | "css" | "asset";

export interface ManifestFile {
  domain?: string;
  path: string;
  kind: FileKind;
  hash: string;
  size: number;
  search?: string;
  hashed?: true;
  fontPages?: readonly string[];
  chunk?: ManifestChunk;
}

/**
 * A chunk Rolldown split off by its own rules, which the next incremental
 * build pins (#720).
 */
export interface ManifestChunk {
  name: string;
  modules: readonly string[];
}

export interface ManifestPage {
  locale: string;
  path: string;
  domain?: string;
  output: string;
  collection?: string;
  entry?: { locale: string; path: string };
  template?: string;
  fallbackFrom?: string;
  dependencies: readonly EntryRef[];
  html: string;
  components: readonly EntryComponent[];
  providers?: string;
  entryChunk?: string;
  foldTuning: readonly FoldAdjustment[];
  variants?: readonly ManifestVariant[];
  inlineScriptHashes?: readonly string[];
  noindex?: true;
}

export interface ManifestVariant {
  name: string;
  html: string;
}

export interface FullRebuildRequest {
  reason: "class-drift";
  drifted: number;
  threshold: number;
}

/** A `build.adapter` artifact written outside the output tree, into `edge/` (#20). */
export interface EdgeManifestFile {
  domain?: string;
  path: string;
}

export interface Manifest {
  version: number;
  build: BuildStamp;
  store: StorePosition;
  site: SiteFacts;
  routing: RoutingManifest;
  files: readonly ManifestFile[];
  pages: readonly ManifestPage[];
  tiers: TierPlan;
  classes: readonly string[];
  fullRebuild?: FullRebuildRequest;
  edge?: { target: string; files: readonly EdgeManifestFile[] };
}

export interface EmittedFile {
  domain?: string;
  path: string;
  kind: FileKind;
  page?: { locale: string; path: string };
  name?: string;
  hashed?: true;
  fontPages?: readonly string[];
  chunk?: ManifestChunk;
  contents: string | Uint8Array;
}

export interface ManifestInput {
  build: BuildStamp;
  store: StorePosition;
  site: SiteFacts;
  routing: RoutingManifest;
  pages: readonly Page[];
  entries: EntryPlan;
  tiers: TierPlan;
  classes: readonly string[];
  fullRebuild?: FullRebuildRequest;
  outputs: readonly EmittedFile[];
  foldTuning: ReadonlyMap<string, readonly FoldAdjustment[]>;
  variants?: ReadonlyMap<string, readonly ManifestVariant[]>;
  inlineScriptHashes?: ReadonlyMap<string, readonly string[]>;
  noindex?: ReadonlySet<string>;
  search?: { adapter: string; files: ReadonlySet<string> };
  edge?: { target: string; files: readonly EdgeManifestFile[] };
}

export function fileKey(domain: string | undefined, path: string): string {
  return domain === undefined || domain === "" ? path : `//${domain}${path}`;
}

const DEPLOY_KEY_RULE =
  'starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character';

// A key that resolves to another key would let a row delete a file it does not name.
// `//` opens a domain tree's key, so the segment after it is the domain.
export function deployKeyFault(key: string): string | undefined {
  const rest = key.startsWith("//") ? key.slice(2) : key.startsWith("/") ? key.slice(1) : undefined;
  const plain =
    rest !== undefined &&
    !/[\\\u0000-\u001F\u007F-\u009F]/.test(key) &&
    rest.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return plain ? undefined : `a deploy key ${DEPLOY_KEY_RULE}`;
}

const EDGE_PATH_RULE =
  'holds no leading "/", ".", ".." or empty segment, no backslash and no control character';

// An `edge.files` row names a bare resource under `edge/`, not a deploy key: `@pagedeck/edge`
// artifacts outside the "tree-file" role carry no leading "/" (`EdgeArtifact.path`).
export function edgePathFault(path: string): string | undefined {
  const plain =
    !path.startsWith("/") &&
    !/[\\\u0000-\u001F\u007F-\u009F]/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return plain ? undefined : `an edge path ${EDGE_PATH_RULE}`;
}

export function deployKeyReport(
  files: readonly EmittedFile[],
  sources: ReadonlyMap<EmittedFile, string>,
): string | undefined {
  let fault: string | undefined;
  const lines: string[] = [];
  for (const file of files) {
    const key = fileKey(file.domain, file.path);
    const refused = deployKeyFault(key);
    if (refused === undefined) continue;
    fault = refused;
    const source = sources.get(file);
    lines.push(`  ${quoteIdentifier(key)}${source === undefined ? "" : ` — from ${quoteIdentifier(source)}`}`);
  }
  if (fault === undefined) return undefined;
  const count = lines.length;
  return `Site build: ${String(count)} ${count === 1 ? "file is" : "files are"} at a key a deploy refuses — ${fault}; rename or delete ${count === 1 ? "it" : "each"}:\n${lines.sort().join("\n")}`;
}

export function collisionLine(key: string, kind: FileKind): string {
  return `  ${JSON.stringify(key)} — the build already emitted ${kindPhrase(kind)} there`;
}

function kindPhrase(kind: FileKind): string {
  return `${kind === "html" || kind === "asset" ? "an" : "a"} ${kind} file`;
}

export function collisionLines(
  files: readonly EmittedFile[],
  emitted: readonly EmittedFile[],
): string[] {
  const already = new Map(
    emitted.map((file) => [fileKey(file.domain, file.path), file.kind]),
  );
  return files
    .flatMap((file) => {
      const key = fileKey(file.domain, file.path);
      const kind = already.get(key);
      return kind === undefined ? [] : [collisionLine(key, kind)];
    })
    .sort();
}

export function pathCollisionReport(
  files: readonly EmittedFile[],
): string | undefined {
  const emitted = new Map<string, FileKind>();
  const beneath = new Map<string, { key: string; kind: FileKind }[]>();
  for (const file of files) {
    if (file.page !== undefined) continue;
    const key = fileKey(file.domain, file.path);
    emitted.set(key, file.kind);
    for (const directory of ancestors(file.path)) {
      const at = fileKey(file.domain, directory);
      const held = beneath.get(at);
      if (held === undefined) beneath.set(at, [{ key, kind: file.kind }]);
      else held.push({ key, kind: file.kind });
    }
  }
  const lines = files
    .flatMap((file) => {
      if (file.page === undefined) return [];
      const key = fileKey(file.domain, file.path);
      const page = `  ${file.page.locale} ${file.page.path} — its document ${JSON.stringify(key)}`;
      const same = emitted.get(key);
      return [
        ...(same === undefined
          ? []
          : [`${page} is where the build emits ${kindPhrase(same)}`]),
        ...ancestors(file.path).flatMap((directory) => {
          const at = fileKey(file.domain, directory);
          const kind = emitted.get(at);
          return kind === undefined
            ? []
            : [
                `${page} needs ${JSON.stringify(at)} as a directory, where the build emits ${kindPhrase(kind)}`,
              ];
        }),
        ...(beneath.get(key) ?? []).map(
          (below) =>
            `${page} is a directory the build needs for the ${below.kind} file ${JSON.stringify(below.key)}`,
        ),
      ];
    })
    .sort();
  if (lines.length === 0) return undefined;
  return `Site build: ${String(lines.length)} ${
    lines.length === 1
      ? "page document collides with a file"
      : "page documents collide with files"
  } this build emits into the same tree — a path in an output tree holds a file or a directory, never both, so no page below can be written beside the file its line names; route each page below at another path, or move the file if it is a passthrough file:\n${lines.join("\n")}`;
}

function ancestors(path: string): string[] {
  const segments = path.split("/").slice(1, -1);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

export function fileHash(contents: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

export function shortHash(
  contents: string | Uint8Array,
  length: number,
): string {
  return fileHash(contents).slice("sha256:".length, "sha256:".length + length);
}

function byteLength(contents: string | Uint8Array): number {
  return typeof contents === "string"
    ? Buffer.byteLength(contents, "utf8")
    : contents.byteLength;
}

function claimantOf(file: EmittedFile): string {
  if (file.page !== undefined) return `${file.kind} for ${pageKey(file.page)}`;
  if (file.name !== undefined) return `${file.kind} named "${file.name}"`;
  return file.kind;
}

function treeOf(domain: string | undefined): string {
  return domain === undefined || domain === ""
    ? "the default tree"
    : `the "${domain}" tree`;
}

function chunkKey(domain: string | undefined, name: string): string {
  return fileKey(domain, `/${name}`);
}

function misclaimReason(
  file: EmittedFile,
  tag: { locale: string; path: string },
  page: Page | undefined,
): string | undefined {
  if (file.kind !== "html")
    return `tagged ${pageKey(tag)}, and its kind is ${file.kind}`;
  if (page !== undefined && page.domain !== file.domain)
    return `tagged ${pageKey(tag)}, and that page renders into ${treeOf(page.domain)}`;
  return undefined;
}

function claim(
  claims: Map<string, string[]>,
  key: string,
  deployKey: string,
): void {
  claims.set(key, [...(claims.get(key) ?? []), deployKey]);
}

const DUPLICATE_KEY_FIX =
  "emit each file once, or write them to distinct paths";
const MISCLAIMED_PAGE_FIX =
  "tag only a page's own HTML file, in that page's output tree";
const CONTESTED_CLAIM_FIX =
  "emit one HTML file per page in each output tree; if none of the site's build.vite.plugins emits a second chunk under a generated entry's name, report it as a Pagedeck bug";
const MISSING_HTML_FIX =
  "emit a file for each page and tag it with the page it renders, or drop the page from the route table";
const UNPLANNED_PAGE_FIX =
  "plan entries over the same pages the manifest is built from";
const MISSING_CHUNK_FIX =
  "place each page's entry chunk in that page's own output tree, harvest every chunk of the build, or check that the bundler's input names still match the entry plan";

function report(headline: string, lines: readonly string[]): string {
  return `Build manifest: ${headline}:\n${lines.join("\n")}`;
}

function duplicateKeyReport(duplicates: ReadonlyMap<string, string[]>): string {
  const count = duplicates.size;
  const subject =
    count === 1
      ? "1 deploy key is claimed by more than one emitted file"
      : `${String(count)} deploy keys are claimed by more than one emitted file`;
  return report(
    `${subject} — ${DUPLICATE_KEY_FIX}`,
    [...duplicates]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, claimants]) => `  "${key}" — ${claimants.join(", ")}`),
  );
}

function misclaimedPageReport(misclaims: readonly string[]): string {
  const count = misclaims.length;
  const subject =
    count === 1
      ? "1 emitted file is tagged with a page it cannot be the HTML of"
      : `${String(count)} emitted files are tagged with pages they cannot be the HTML of`;
  return report(`${subject} — ${MISCLAIMED_PAGE_FIX}`, [...misclaims].sort());
}

function contestedClaimReport(
  contested: readonly (readonly [string, readonly string[]])[],
): string {
  const count = contested.length;
  const subject =
    count === 1
      ? "1 claim is made by more than one emitted file"
      : `${String(count)} claims are made by more than one emitted file`;
  return report(
    `${subject} — ${CONTESTED_CLAIM_FIX}`,
    contested
      .map(
        ([what, keys]) =>
          `  ${what} — ${[...keys]
            .sort()
            .map((key) => `"${key}"`)
            .join(", ")}`,
      )
      .sort(),
  );
}

function missingHtmlReport(pages: readonly Page[]): string {
  const count = pages.length;
  const subject =
    count === 1
      ? "1 page emitted no HTML"
      : `${String(count)} pages emitted no HTML`;
  return report(
    `${subject} — ${MISSING_HTML_FIX}`,
    pages.map((page) => `  ${pageKey(page)}`),
  );
}

function unplannedPageReport(pages: readonly Page[]): string {
  const count = pages.length;
  const subject =
    count === 1
      ? "1 page is in neither the entry plan's entries nor its content-only pages"
      : `${String(count)} pages are in neither the entry plan's entries nor its content-only pages`;
  return report(
    `${subject} — ${UNPLANNED_PAGE_FIX}`,
    pages.map((page) => `  ${pageKey(page)}`),
  );
}

function missingChunkReport(
  unbuilt: readonly { page: Page; entry: PageEntry }[],
): string {
  const count = unbuilt.length;
  const subject =
    count === 1
      ? "1 page entry matched no emitted chunk in its own output tree"
      : `${String(count)} page entries matched no emitted chunk in their own output tree`;
  return report(
    `${subject} — ${MISSING_CHUNK_FIX}`,
    unbuilt.map(
      ({ page, entry }) =>
        `  ${pageKey(page)} — entry name "${entry.name}", looked for in ${treeOf(page.domain)}`,
    ),
  );
}

function beforeFile(a: ManifestFile, b: ManifestFile): number {
  const left = a.domain ?? "";
  const right = b.domain ?? "";
  if (left !== right) return left < right ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

export function buildManifest(input: ManifestInput): Manifest {
  const files: ManifestFile[] = [];
  const byKey = new Map<string, EmittedFile[]>();
  const htmlClaims = new Map<string, string[]>();
  const chunkClaims = new Map<string, string[]>();
  const chunkSubjects = new Map<string, string>();
  const misclaims: string[] = [];
  const pageOfKey = new Map(input.pages.map((page) => [pageKey(page), page]));
  const entryNames = new Set(input.entries.entries.map((entry) => entry.name));

  for (const emitted of input.outputs) {
    const key = fileKey(emitted.domain, emitted.path);
    byKey.set(key, [...(byKey.get(key) ?? []), emitted]);
    files.push({
      ...(emitted.domain === undefined ? {} : { domain: emitted.domain }),
      path: emitted.path,
      kind: emitted.kind,
      hash: fileHash(emitted.contents),
      size: byteLength(emitted.contents),
      ...(input.search?.files.has(key) === true
        ? { search: input.search.adapter }
        : {}),
      ...(emitted.hashed === true ? { hashed: true as const } : {}),
      ...(emitted.fontPages === undefined ? {} : { fontPages: emitted.fontPages }),
      ...(emitted.chunk === undefined ? {} : { chunk: emitted.chunk }),
    });
    if (emitted.page !== undefined) {
      const reason = misclaimReason(
        emitted,
        emitted.page,
        pageOfKey.get(pageKey(emitted.page)),
      );
      if (reason === undefined) claim(htmlClaims, pageKey(emitted.page), key);
      else misclaims.push(`  "${key}" — ${reason}`);
    }
    if (emitted.name !== undefined && entryNames.has(emitted.name)) {
      const claimed = chunkKey(emitted.domain, emitted.name);
      chunkSubjects.set(
        claimed,
        `entry chunk name "${emitted.name}" in ${treeOf(emitted.domain)}`,
      );
      claim(chunkClaims, claimed, key);
    }
  }

  const duplicates = new Map<string, string[]>();
  for (const [key, claimants] of byKey) {
    if (claimants.length > 1) duplicates.set(key, claimants.map(claimantOf));
  }
  if (duplicates.size > 0) throw new Error(duplicateKeyReport(duplicates));

  if (misclaims.length > 0) throw new Error(misclaimedPageReport(misclaims));

  // After the tag check: a rejected file is not a claimant, so one mistake is
  // reported once.
  const contested = [
    ...[...htmlClaims].map(
      ([page, keys]) => [`page ${page}`, keys] as readonly [string, string[]],
    ),
    ...[...chunkClaims].map(
      ([claimed, keys]) =>
        [chunkSubjects.get(claimed) as string, keys] as readonly [
          string,
          string[],
        ],
    ),
  ].filter(([, keys]) => keys.length > 1);
  if (contested.length > 0) throw new Error(contestedClaimReport(contested));

  const sole = (claims: ReadonlyMap<string, readonly string[]>) =>
    new Map([...claims].map(([key, [first]]) => [key, first as string]));
  const htmlOfPage = sole(htmlClaims);
  const chunkOfKey = sole(chunkClaims);

  const entryOfPage = new Map(
    input.entries.entries.map((entry) => [pageKey(entry), entry]),
  );
  const contentOnly = new Set(input.entries.contentOnly.map(pageKey));

  const unrendered = input.pages.filter(
    (page) => !htmlOfPage.has(pageKey(page)),
  );
  if (unrendered.length > 0) throw new Error(missingHtmlReport(unrendered));

  const unplanned = input.pages.filter(
    (page) =>
      !entryOfPage.has(pageKey(page)) && !contentOnly.has(pageKey(page)),
  );
  if (unplanned.length > 0) throw new Error(unplannedPageReport(unplanned));

  const unbuilt = input.pages.flatMap((page) => {
    const entry = entryOfPage.get(pageKey(page));
    if (entry === undefined) return [];
    return chunkOfKey.has(chunkKey(page.domain, entry.name))
      ? []
      : [{ page, entry }];
  });
  if (unbuilt.length > 0) throw new Error(missingChunkReport(unbuilt));

  const pages = input.pages.map((page): ManifestPage => {
    const entry = entryOfPage.get(pageKey(page));
    // Sorted here, not trusted: a compiler walks the weights in this order.
    const variants = [...(input.variants?.get(pageKey(page)) ?? [])].sort(
      (a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1),
    );
    const inlineScriptHashes = input.inlineScriptHashes?.get(pageKey(page));
    return {
      locale: page.locale,
      path: page.path,
      ...(page.domain === undefined ? {} : { domain: page.domain }),
      output: page.output,
      ...(page.collection === undefined ? {} : { collection: page.collection }),
      ...(page.entry === undefined
        ? {}
        : { entry: { locale: page.entry.locale, path: page.entry.path } }),
      ...(page.template === undefined ? {} : { template: page.template }),
      ...(page.fallbackFrom === undefined
        ? {}
        : { fallbackFrom: page.fallbackFrom }),
      dependencies: page.dependencies,
      // Checked above, so the read is total.
      html: htmlOfPage.get(pageKey(page)) as string,
      components: entry?.components ?? [],
      ...(entry?.providers === undefined ? {} : { providers: entry.providers }),
      ...(entry === undefined
        ? {}
        : {
            entryChunk: chunkOfKey.get(
              chunkKey(page.domain, entry.name),
            ) as string,
          }),
      foldTuning: input.foldTuning.get(pageKey(page)) ?? [],
      // Each last and omitted when absent, so a site without the feature keeps
      // its bytes (#34).
      ...(variants.length === 0 ? {} : { variants }),
      ...(inlineScriptHashes === undefined ? {} : { inlineScriptHashes }),
      ...(input.noindex?.has(pageKey(page)) === true
        ? { noindex: true as const }
        : {}),
    };
  });

  return {
    version: MANIFEST_VERSION,
    build: input.build,
    store: input.store,
    site: input.site,
    routing: input.routing,
    files: files.sort(beforeFile),
    pages,
    tiers: input.tiers,
    classes: [...new Set(input.classes)].sort(),
    ...(input.fullRebuild === undefined
      ? {}
      : { fullRebuild: input.fullRebuild }),
    ...(input.edge === undefined ? {} : { edge: input.edge }),
  };
}

/**
 * Key order spelled out: the golden is a public contract, and the order an
 * object happened to be built in is not one.
 */
function ordered(manifest: Manifest): unknown {
  const optional = <T>(key: string, value: T | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    version: manifest.version,
    build: {
      id: manifest.build.id,
      createdAt: manifest.build.createdAt,
      ...optional("parent", manifest.build.parent),
    },
    store: { seq: manifest.store.seq },
    site: { trailingSlash: manifest.site.trailingSlash },
    routing: manifest.routing,
    files: manifest.files.map((file) => ({
      ...optional("domain", file.domain),
      path: file.path,
      kind: file.kind,
      hash: file.hash,
      size: file.size,
      // Last and omitted when absent, so a row without them keeps its bytes.
      ...optional("search", file.search),
      ...optional("hashed", file.hashed),
      ...optional("fontPages", file.fontPages),
      ...optional(
        "chunk",
        file.chunk === undefined
          ? undefined
          : { name: file.chunk.name, modules: file.chunk.modules },
      ),
    })),
    pages: manifest.pages.map((page) => ({
      locale: page.locale,
      path: page.path,
      ...optional("domain", page.domain),
      output: page.output,
      ...optional("collection", page.collection),
      ...optional(
        "entry",
        page.entry === undefined
          ? undefined
          : { locale: page.entry.locale, path: page.entry.path },
      ),
      ...optional("template", page.template),
      ...optional("fallbackFrom", page.fallbackFrom),
      dependencies: page.dependencies.map((ref) => ({
        collection: ref.collection,
        locale: ref.locale,
        path: ref.path,
      })),
      html: page.html,
      components: page.components.map((component) => ({
        name: component.name,
        module: component.module,
        eager: component.eager,
      })),
      ...optional("providers", page.providers),
      ...optional("entryChunk", page.entryChunk),
      foldTuning: page.foldTuning.map((adjustment) => ({
        component: adjustment.component,
        position: adjustment.position,
        from: adjustment.from,
        to: adjustment.to,
      })),
      ...optional(
        "variants",
        page.variants?.map((variant) => ({
          name: variant.name,
          html: variant.html,
        })),
      ),
      ...optional("inlineScriptHashes", page.inlineScriptHashes),
      ...optional("noindex", page.noindex),
    })),
    tiers: manifest.tiers,
    classes: manifest.classes,
    ...optional(
      "fullRebuild",
      manifest.fullRebuild === undefined
        ? undefined
        : {
            reason: manifest.fullRebuild.reason,
            drifted: manifest.fullRebuild.drifted,
            threshold: manifest.fullRebuild.threshold,
          },
    ),
    ...optional(
      "edge",
      manifest.edge === undefined
        ? undefined
        : {
            target: manifest.edge.target,
            files: manifest.edge.files.map((file) => ({
              ...optional("domain", file.domain),
              path: file.path,
            })),
          },
    ),
  };
}

export function manifestJson(manifest: Manifest): string {
  return `${JSON.stringify(ordered(manifest), null, 2)}\n`;
}

type Check = (value: unknown, at: string, faults: string[]) => void;

/** `-?`: a column added to `Manifest` is a compile error here until checked. */
type Shape<T> = { readonly [K in keyof T]-?: Check };

function found(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

function fault(at: string, expected: string, value: unknown): string {
  return `${at}: expected ${expected}, found ${found(value)}`;
}

function primitive(type: "string" | "number" | "boolean"): Check {
  return (value, at, faults) => {
    if (typeof value !== type) faults.push(fault(at, `a ${type}`, value));
  };
}

const STRING = primitive("string");
const NUMBER = primitive("number");
const BOOLEAN = primitive("boolean");

function optional(check: Check, expected: string): Check {
  return (value, at, faults) => {
    if (value === undefined) return;
    const own: string[] = [];
    check(value, at, own);
    if (own[0]?.startsWith(`${at}: `) === true) {
      faults.push(fault(at, `${expected} or nothing`, value));
    } else faults.push(...own);
  };
}

function list(item: Check): Check {
  return (value, at, faults) => {
    if (!Array.isArray(value)) {
      faults.push(fault(at, "a list", value));
      return;
    }
    for (const [index, element] of (value as unknown[]).entries()) {
      item(element, `${at}[${String(index)}]`, faults);
    }
  };
}

function record<T>(shape: Shape<T>): Check {
  return (value, at, faults) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      faults.push(fault(at, "an object", value));
      return;
    }
    for (const [key, check] of Object.entries(shape) as [string, Check][]) {
      check(
        (value as Record<string, unknown>)[key],
        at === "" ? key : `${at}.${key}`,
        faults,
      );
    }
  };
}

const OPTIONAL_STRING = optional(STRING, "a string");

const OPTIONAL_TRUE: Check = (value, at, faults) => {
  if (value === undefined || value === true) return;
  faults.push(
    `${at}: expected true or nothing, found ${value === false ? "false" : found(value)}`,
  );
};

const ROUTING_SHAPE = record<RoutingManifest>({
  version: NUMBER,
  site: record<SiteFacts>({ trailingSlash: STRING }),
  trees: list(
    record<RoutingTree>({
      domain: OPTIONAL_STRING,
      redirects: list(
        record<ResolvedRedirect>({
          from: STRING,
          to: STRING,
          status: NUMBER,
          source: STRING,
          via: list(STRING),
          file: OPTIONAL_TRUE,
        }),
      ),
      notFound: OPTIONAL_STRING,
      headers: list(
        record<HeaderRule>({
          prefix: STRING,
          set: list(record<HeaderField>({ name: STRING, value: STRING })),
        }),
      ),
      experiments: optional(
        list(
          record<ResolvedExperiment>({
            path: STRING,
            cookie: STRING,
            variants: list(
              record<WeightedVariant>({ name: STRING, weight: NUMBER }),
            ),
          }),
        ),
        "a list",
      ),
    }),
  ),
});

const TIERS_SHAPE = record<TierPlan>({
  policy: record<TierPolicy>({
    coreMinShare: NUMBER,
    coreMinUsageShare: NUMBER,
    midMinPages: NUMBER,
    exclude: list(STRING),
    minSize: NUMBER,
    minShareCount: NUMBER,
  }),
  pageCount: NUMBER,
  shippedUsages: NUMBER,
  groups: list(
    record<TierGroup>({
      name: STRING,
      priority: NUMBER,
      entriesAware: BOOLEAN,
      entriesAwareMergeThreshold: optional(NUMBER, "a number"),
      minSize: NUMBER,
      minShareCount: NUMBER,
      modules: list(STRING),
    }),
  ),
  assignments: list(
    record<TierAssignment>({
      component: STRING,
      module: STRING,
      tier: STRING,
      group: OPTIONAL_STRING,
      pageCount: NUMBER,
      pageShare: NUMBER,
      totalUsages: NUMBER,
      usageShare: NUMBER,
      avgFoldScore: NUMBER,
    }),
  ),
});

const MANIFEST_SHAPE = record<Manifest>({
  version: NUMBER,
  build: record<BuildStamp>({
    id: STRING,
    createdAt: STRING,
    parent: OPTIONAL_STRING,
  }),
  store: record<StorePosition>({ seq: NUMBER }),
  site: record<SiteFacts>({ trailingSlash: STRING }),
  routing: ROUTING_SHAPE,
  files: list(
    record<ManifestFile>({
      domain: OPTIONAL_STRING,
      path: STRING,
      kind: STRING,
      hash: STRING,
      size: NUMBER,
      search: OPTIONAL_STRING,
      hashed: OPTIONAL_TRUE,
      fontPages: optional(list(STRING), "a list"),
      chunk: optional(
        record<ManifestChunk>({ name: STRING, modules: list(STRING) }),
        "an object",
      ),
    }),
  ),
  pages: list(
    record<ManifestPage>({
      locale: STRING,
      path: STRING,
      domain: OPTIONAL_STRING,
      output: STRING,
      collection: OPTIONAL_STRING,
      entry: optional(
        record<NonNullable<ManifestPage["entry"]>>({
          locale: STRING,
          path: STRING,
        }),
        "an object",
      ),
      template: OPTIONAL_STRING,
      fallbackFrom: OPTIONAL_STRING,
      dependencies: list(
        record<EntryRef>({ collection: STRING, locale: STRING, path: STRING }),
      ),
      html: STRING,
      components: list(
        record<EntryComponent>({ name: STRING, module: STRING, eager: BOOLEAN }),
      ),
      providers: OPTIONAL_STRING,
      entryChunk: OPTIONAL_STRING,
      foldTuning: list(
        record<FoldAdjustment>({
          component: STRING,
          position: NUMBER,
          from: STRING,
          to: STRING,
        }),
      ),
      variants: optional(
        list(record<ManifestVariant>({ name: STRING, html: STRING })),
        "a list",
      ),
      inlineScriptHashes: optional(list(STRING), "a list"),
      noindex: OPTIONAL_TRUE,
    }),
  ),
  tiers: TIERS_SHAPE,
  classes: list(STRING),
  fullRebuild: optional(
    record<FullRebuildRequest>({
      reason: STRING,
      drifted: NUMBER,
      threshold: NUMBER,
    }),
    "an object",
  ),
  edge: optional(
    record<NonNullable<Manifest["edge"]>>({
      target: STRING,
      files: list(
        record<EdgeManifestFile>({ domain: OPTIONAL_STRING, path: STRING }),
      ),
    }),
    "an object",
  ),
});

/**
 * Checks every field's JS type, and that each file row's deploy key and each
 * routing tree's key resolve to themselves (#659, #669); any other meaning a
 * reader that deletes by a row asks itself (`untrustedRows`, `indexFiles`, #529).
 */
export function readManifest(text: string, source: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(
      `Manifest ${quoteIdentifier(source)}: is not valid JSON — pagedeck build writes it, so re-run the build that produced it`,
      { cause },
    );
  }
  const version: unknown =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? (parsed as { version: unknown }).version
      : undefined;
  if (typeof version !== "number") {
    throw new ConfigError(
      `Manifest ${quoteIdentifier(source)}: declares no version — every manifest pagedeck build writes has one, so re-run the build that produced it`,
    );
  }
  if (version !== MANIFEST_VERSION) {
    throw new ConfigError(
      `Manifest ${quoteIdentifier(source)}: is version ${String(version)}, and this build reads version ${String(MANIFEST_VERSION)} — upgrade pagedeck, or read a manifest this version wrote`,
    );
  }
  const faults: string[] = [];
  MANIFEST_SHAPE(parsed, "", faults);
  if (faults.length === 0) {
    for (const [index, file] of (parsed as Manifest).files.entries()) {
      const key = fileKey(file.domain, file.path);
      if (deployKeyFault(key) !== undefined) {
        faults.push(
          `files[${String(index)}]: expected a deploy key that ${DEPLOY_KEY_RULE}, found ${quoteIdentifier(key)}`,
        );
      }
    }
    for (const [index, tree] of (parsed as Manifest).routing.trees.entries()) {
      if (tree.domain === undefined) continue;
      const key = `//${tree.domain}`;
      if (deployKeyFault(key) !== undefined) {
        faults.push(
          `routing.trees[${String(index)}].domain: expected a tree key whose deploy key ${DEPLOY_KEY_RULE}, found ${quoteIdentifier(key)}`,
        );
      }
    }
    for (const [index, file] of (
      (parsed as Manifest).edge?.files ?? []
    ).entries()) {
      if (file.domain !== undefined) {
        const key = `//${file.domain}`;
        if (deployKeyFault(key) !== undefined) {
          faults.push(
            `edge.files[${String(index)}].domain: expected a tree key whose deploy key ${DEPLOY_KEY_RULE}, found ${quoteIdentifier(key)}`,
          );
        }
      }
      const reason = edgePathFault(file.path);
      if (reason !== undefined) {
        faults.push(
          `edge.files[${String(index)}].path: expected ${reason}, found ${quoteIdentifier(file.path)}`,
        );
      }
    }
  }
  if (faults.length > 0) {
    // One line: two readers nest this message in their own report through
    // `printable`, which would mangle a line break.
    const count = faults.length;
    throw new ConfigError(
      `Manifest ${quoteIdentifier(source)}: ${String(count)} ${count === 1 ? "field does" : "fields do"} not hold what pagedeck build writes there (${faults.join("; ")}), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    );
  }
  return parsed as Manifest;
}
