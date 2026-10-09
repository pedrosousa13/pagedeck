import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { openStoreReadOnly } from "@pagedeck/content";
import type { ContentStoreReader } from "@pagedeck/content";
import { rootProviderStackDigest } from "@pagedeck/islands/root-provider-check";
import {
  budgetReportPath,
  budgetReportJson,
  checkBudgets,
  islandPropsLimit,
  planBudgets,
  weighIslandProps,
} from "./budgets.js";
import { adapterEdgeArtifacts, adapterTreeFiles } from "./build-adapter.js";
import type { BuildAdapterArtifact } from "./build-adapter.js";
import type { BudgetChunk, BudgetReport, BudgetStylesheet } from "./budgets.js";
import { outputDir } from "./config.js";
import type { LoadedBuildSection, LoadedConfig } from "./config.js";
import { classesOfHtml } from "./classes.js";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { installClientReferences } from "./client-reference-loader.js";
import { inlineStyleElements, inlinedPages } from "./critical-css.js";
import { checkDrift, driftWarnings } from "./drift.js";
import { planEntries, runtimeImports } from "./entries.js";
import type { EntryPlan, IslandInstance, PageDemand, PageEntry } from "./entries.js";
import { ConfigError, describeError, printable } from "./exit.js";
import { absentFaviconWarning, faviconFiles } from "./favicon.js";
import { feedFiles, feedUrl } from "./feed.js";
import { foldCause, resolveFoldStrategy } from "./fold.js";
import type { FoldAdjustment, FoldStrategy } from "./fold.js";
import {
  fallbackFontFaceRule,
  fallbackMetricsFor,
  fontFaceRule,
  fontPreloadLink,
} from "./fonts.js";
import type { FontFace, FontsSetting, FontSubsetResult } from "./fonts.js";
import type {
  SocialImageInputs,
  SocialImageResult,
  SocialImagesSetting,
} from "./social-image.js";
import { localeAlternates, pageLinks, variantUrl } from "./alternates.js";
import type { PageLinks } from "./alternates.js";
import {
  absorbedHeadConflicts,
  escapeAttributeValue,
  headElements,
  quotedValue,
} from "./head.js";
import type { PageHead, SocialImageDimensions } from "./head.js";
import { scanIslandFacts } from "./island-facts.js";
import { contentOf, layoutContents } from "./layout.js";
import {
  checkSiteLinks,
  movedReferenceReport,
  movedReferences,
  resolveLinkCheck,
  textOf,
} from "./links.js";
import type { BrokenReference } from "./links.js";
import { localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import {
  crossPageAffected,
  mergeDemands,
  pageKey,
  planIncremental,
  publicationChanges,
  readDelta,
} from "./incremental.js";
import type {
  AffectedPage,
  AffectedReason,
  IncrementalPlan,
  RedirectRecord,
  ReusedPage,
} from "./incremental.js";
import {
  buildManifest,
  deployKeyReport,
  fileHash,
  fileKey,
  MANIFEST_FILE,
  manifestJson,
  pathCollisionReport,
  readManifest,
  shortHash,
} from "./manifest.js";
import type {
  BuildStamp,
  EdgeManifestFile,
  EmittedFile,
  Manifest,
  ManifestChunk,
  ManifestFile,
  ManifestVariant,
} from "./manifest.js";
import { matchingPattern, parsePatterns } from "./page-patterns.js";
import type { PageIdentity } from "./page-patterns.js";
import { collectPages } from "./pages.js";
import type { Page } from "./pages.js";
import { quote, quoteIdentifier } from "./quote.js";
import { RenderError, renderPage } from "./render.js";
import { DEFAULT_RETENTION_POLICY, retainManifest } from "./retention.js";
import type { AbsorbedMetadata, ChromeMarkup, SocialCard } from "./render.js";
import {
  notFoundPages,
  planRouting,
  undeclaredHeadersWarning,
  variantPath,
} from "./routing.js";
import {
  contentRelativeReferences,
  passthroughAddress,
  passthroughFiles,
} from "./passthrough.js";
import type { ContentRelativeReference } from "./passthrough.js";
import type { PassthroughSetting, PassthroughSource } from "./passthrough.js";
import { previewFiles } from "./preview.js";
import type { PreviewSetting } from "./preview.js";
import { buildPreview } from "./preview-build.js";
import { planPreview } from "./preview-entry.js";
import { robotsFiles } from "./robots.js";
import { isScriptLoaderText, scriptElements } from "./script-elements.js";
import type { FacadePlaceholder } from "./script-elements.js";
import { beaconElement, isBeaconText } from "./beacon.js";
import {
  unloadedScriptWarning,
  workerConsentWarning,
  workerFallbackWarning,
} from "./scripts.js";
import {
  searchDocuments,
  searchFiles,
  searchPatchFiles,
} from "./search.js";
import type { SearchRemoval } from "./search.js";
import { sitemapFiles, sitemapPath } from "./sitemap.js";
import type { SitemapPattern } from "./sitemap.js";
import { speculationRules } from "./speculation.js";
import { installStylesheetStubs } from "./stylesheet-loader.js";
import { compileSupplements } from "./supplement.js";
import { planTiers } from "./tiers.js";
import type { TierPlan } from "./tiers.js";
import { entryId } from "@pagedeck/islands";
import type { ModuleFacts } from "@pagedeck/islands";

export interface BuildSiteInput {
  config: LoadedConfig;
  stamp: BuildStamp;
  incremental?: boolean;
}

export interface SitePatch {
  written: readonly EmittedFile[];
  pruned: readonly { domain?: string; path: string }[];
  stats: IncrementalPlan["stats"];
  redirects: readonly RedirectRecord[];
  wholeIndex?: WholeIndex;
}

export type WholeIndex = Extract<
  AffectedReason,
  { kind: "unpatched-index" | "no-previous-index" }
>;

export interface SiteBuild {
  outDir: string;
  pages: readonly Page[];
  entries: EntryPlan;
  tiers: TierPlan;
  files: readonly EmittedFile[];
  manifest: Manifest;
  patch?: SitePatch;
  warnings: readonly string[];
  /** What `build.adapter` wrote outside the output tree, written into `edge/` (#20). */
  edgeArtifacts?: readonly BuildAdapterArtifact[];
}

const MISSING_BUILD_FIX =
  "add a build section to pagedeck.config.ts — build: { pages, components, content }";

const MISSING_FAVICON_FIX =
  "point src at the site's icon file, or remove favicon";
const MISSING_PASSTHROUGH_FIX =
  "point root at the directory of files the site publishes";
const MISSING_CONTENT_ROOT_FIX =
  "point contentRoot at the content tree a page's content-relative references resolve into";
const UNRESOLVED_REFERENCE_FIX =
  'put the file at that path beneath the directory "build.passthrough.contentRoot" names, or point the reference at a file that is already there';
const NO_CONTENT_ENTRY =
  "no content entry: no stored entry backs this page, so the reference is in whatever composed it";
const UNHELD_FIX =
  "check the module map names a module this build bundles, and report it with the id below if it does";

function contentReferenceLine(reference: ContentRelativeReference): string {
  return `  ${reference.page} — ${quote(reference.href)} → ${quote(reference.address)} — ${
    reference.entry === undefined
      ? NO_CONTENT_ENTRY
      : `content entry ${quote(reference.entry)}`
  }`;
}

function undeclaredContentRootWarning(
  references: readonly ContentRelativeReference[],
): string | undefined {
  if (references.length === 0) return undefined;
  const subject =
    references.length === 1
      ? "1 content-relative reference resolves to nothing this build publishes"
      : `${String(references.length)} content-relative references resolve to nothing this build publishes`;
  return `Passthrough: ${subject}, because this site declares no build.passthrough.contentRoot — a content-relative reference resolves against the address its page is served at, and the file it names is published from the content tree that key declares, so without it each page below points at an address nothing in this build emits; this is a warning and not a refusal because the host may serve these files from somewhere this build never reads — declare build.passthrough.contentRoot as the directory these files sit beneath, and the build publishes each one and refuses any that is missing:\n${references.map(contentReferenceLine).join("\n")}`;
}

async function previousBuild(input: {
  store: ContentStoreReader;
  outDir: string;
}): Promise<Manifest> {
  const file = join(input.outDir, MANIFEST_FILE);
  let previous: Manifest;
  try {
    previous = readManifest(await readFile(file, "utf8"), file);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `Manifest "${file}": could not be read, so pagedeck build --incremental has no previous build to merge into — run pagedeck build to write it, then re-run with --incremental`,
      { cause },
    );
  }

  // Each row becomes a deletion under `outDir`, so a row no build wrote is
  // refused (#524).
  const faults = await untrustedRows(input.outDir, file, previous);
  if (faults.length > 0) {
    throw new ConfigError(
      `Manifest "${file}": pagedeck build --incremental cannot trust this document to decide which files to delete, so it wrote and deleted nothing — an incremental build deletes each file the previous build's manifest names and its own does not, and each fault below shows this document was not written by a build, so none of its rows can be trusted to choose a deletion — run pagedeck build, which builds the whole site, deletes nothing this document names, warns that it did not, and writes a manifest the next incremental build can use:\n${faults.map((line) => `  ${printable(line)}`).join("\n")}`,
    );
  }

  const head = input.store.getLastSeq();
  if (previous.store.seq > head) {
    throw new ConfigError(
      `Manifest "${file}": records store position ${String(previous.store.seq)} and this store's position is ${String(head)}, so the changes since that build cannot be read — this store was restored from a snapshot or is a different one, so run pagedeck build to rebuild the whole site against it`,
    );
  }
  return previous;
}

async function prunableBuild(
  outDir: string,
): Promise<{ previous?: Manifest; warning?: string }> {
  const file = join(outDir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return {
      warning: unprunedTreeWarning(outDir, [
        `Manifest ${quoteIdentifier(file)}: could not be opened (${code ?? "no error code"}), so which files the earlier build wrote cannot be read from it — make it a file this build can read, or delete it`,
      ]),
    };
  }
  let previous: Manifest;
  try {
    previous = readManifest(text, file);
  } catch (cause) {
    return { warning: unprunedTreeWarning(outDir, [describeError(cause)]) };
  }
  const faults = await untrustedRows(outDir, file, previous);
  if (faults.length > 0) {
    return { warning: unprunedTreeWarning(outDir, faults) };
  }
  return { previous };
}

async function untrustedRows(
  outDir: string,
  file: string,
  manifest: Manifest,
): Promise<string[]> {
  const root = resolve(outDir) + sep;
  const own = resolve(outDir, MANIFEST_FILE);
  const realRoot = await realpath(outDir);
  const faults: string[] = [];
  for (const [index, { path, domain }] of manifest.files.entries()) {
    const at = `Manifest "${file}": files row ${String(index)}`;
    const names = `${at} names ${quoteIdentifier(path)}${domain === undefined ? "" : ` in domain ${quoteIdentifier(domain)}`}`;
    if (path.includes("\0") || (domain ?? "").includes("\0")) {
      faults.push(`${names}, which holds a NUL character — pagedeck build writes none, so this row was not written by a build`);
      continue;
    }
    const target = resolve(join(outDir, domain ?? "", path));
    if (!target.startsWith(root)) {
      faults.push(`${names}, which resolves outside the output directory — pagedeck build writes only paths inside it, so this row was not written by a build`);
      continue;
    }
    if (target === own) {
      faults.push(`${names}, which is the manifest this build writes — pagedeck build never lists its own manifest as a file, so this row was not written by a build`);
      continue;
    }
    const fault = await onDiskFault(target, realRoot);
    if (fault !== undefined) faults.push(`${names}, ${fault}`);
  }
  return faults;
}

async function onDiskFault(
  target: string,
  realRoot: string,
): Promise<string | undefined> {
  const suffix = "so this row was not written by a build";
  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return `which could not be checked (${code ?? "no error code"}) — pagedeck build writes only paths it can reach, ${suffix}`;
  }
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) {
    return `which resolves outside the output directory through a symbolic link — pagedeck build writes only paths inside it, ${suffix}`;
  }
  try {
    const stat = await lstat(target);
    if (!stat.isFile()) {
      return `which is not a regular file — pagedeck build writes only regular files, ${suffix}`;
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return `which could not be checked (${code ?? "no error code"}) — pagedeck build writes only paths it can reach, ${suffix}`;
  }
  return undefined;
}

function unprunedTreeWarning(outDir: string, lines: readonly string[]): string {
  return `Output "${outDir}": this build removed no file an earlier build wrote there, because the manifest.json it left is not one this build can prune against — a full build deletes each file the previous build's manifest names and its own does not, and without that document it cannot tell a file an earlier build wrote from one placed there by hand, so a page that build published and this one did not, such as a post set to draft since, may still be in the directory; this is a warning and not a refusal because every file this build wrote is correct and the manifest it wrote is the one the next build prunes against — before a deploy that syncs this directory, delete the pages that build published and this one did not, or point build.outDir at a new, empty directory and build again; a deploy that reads the manifest needs neither:\n${lines.map((line) => `  ${printable(line)}`).join("\n")}`;
}

async function carryDocuments(input: {
  outDir: string;
  previous: Manifest;
  reuse: readonly ReusedPage[];
}): Promise<ReadonlyMap<string, EmittedFile>> {
  const rows = new Map(
    input.previous.files.map((file) => [fileKey(file.domain, file.path), file]),
  );
  const carried = new Map<string, EmittedFile>();
  const faults: string[] = [];
  for (const { page, previous } of input.reuse) {
    const subject = `  "${previous.html}" — ${pageKey(page)}'s document, and`;
    const row = rows.get(previous.html);
    if (row === undefined) {
      faults.push(`${subject} the previous manifest lists no file at that key`);
      continue;
    }
    const file = join(input.outDir, row.domain ?? "", row.path);
    let contents: string | undefined;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      faults.push(`${subject} the tree does not hold it`);
      continue;
    }
    if (fileHash(contents) !== row.hash) {
      faults.push(
        `${subject} the bytes there are not the ones the previous build recorded`,
      );
      continue;
    }
    const landmarks = mainLandmarks(contents);
    if (landmarks > 1) {
      faults.push(
        `${subject} it holds ${String(landmarks)} <main> landmarks — the bytes are the ones the previous build recorded, so that build wrote them before this one refused a second landmark; render <section>, <div> or a fragment where the component renders <main> (CONTEXT.md, "The <main> landmark is the framework's, written once per document")`,
      );
      continue;
    }
    carried.set(pageKey(page), {
      ...(row.domain === undefined ? {} : { domain: row.domain }),
      path: row.path,
      kind: row.kind,
      page: { locale: page.locale, path: page.path },
      contents,
    });
  }
  if (faults.length > 0) {
    throw new ConfigError(
      `Output "${input.outDir}": ${String(faults.length)} reused ${
        faults.length === 1 ? "page" : "pages"
      } cannot be carried from the previous build — an incremental build reads a page it does not render back off this tree rather than composing it again, so a document the previous manifest does not name, or that this tree does not hold as that build wrote it, has no bytes to carry, and one this build would refuse to compose is not carried past that refusal — run pagedeck build to write the whole site again:\n${faults.join("\n")}`,
    );
  }
  return carried;
}

async function carrySitemaps(input: {
  outDir: string;
  previous: Manifest;
  plan: IncrementalPlan;
  pages: readonly Page[];
  pattern: SitemapPattern;
  locales: LocaleSet;
}): Promise<ReadonlyMap<string, EmittedFile>> {
  const movedPaths = new Set<string>();
  const dirty = new Set<string>();
  for (const affected of input.plan.render) {
    const structural = affected.reasons.some(
      (reason) =>
        reason.kind === "new-page" ||
        reason.kind === "moved" ||
        reason.kind === "not-found",
    );
    if (!structural) continue;
    dirty.add(affected.page.locale);
    movedPaths.add(affected.page.path);
  }
  for (const removal of input.plan.remove) {
    dirty.add(removal.page.locale);
    movedPaths.add(removal.page.path);
  }
  for (const page of input.pages) {
    if (movedPaths.has(page.path)) dirty.add(page.locale);
  }

  const rows = new Map(
    input.previous.files.map((file) => [fileKey(file.domain, file.path), file]),
  );
  const carried = new Map<string, EmittedFile>();
  for (const locale of input.locales.values()) {
    if (dirty.has(locale.code)) continue;
    const key = fileKey(
      localeTree(locale),
      sitemapPath(input.pattern, locale.code),
    );
    const row = rows.get(key);
    if (row === undefined) continue;
    let contents: string;
    try {
      contents = await readFile(
        join(input.outDir, row.domain ?? "", row.path),
        "utf8",
      );
    } catch {
      continue;
    }
    if (fileHash(contents) !== row.hash) continue;
    carried.set(key, {
      ...(row.domain === undefined ? {} : { domain: row.domain }),
      path: row.path,
      kind: row.kind,
      contents,
    });
  }
  return carried;
}

async function carrySearchIndex(input: {
  outDir: string;
  previous: Manifest;
  adapter: string;
}): Promise<readonly EmittedFile[]> {
  const files: EmittedFile[] = [];
  const faults: string[] = [];
  const causes: unknown[] = [];
  for (const row of input.previous.files) {
    if (row.search !== input.adapter) continue;
    const subject = `  ${JSON.stringify(fileKey(row.domain, row.path))} —`;
    let contents: Uint8Array;
    try {
      contents = await readFile(join(input.outDir, row.domain ?? "", row.path));
    } catch (cause) {
      causes.push(cause);
      const absent = (cause as { code?: unknown }).code === "ENOENT";
      faults.push(
        absent
          ? `${subject} the tree does not hold it`
          : `${subject} the tree holds it and it could not be read`,
      );
      continue;
    }
    if (fileHash(contents) !== row.hash) {
      faults.push(
        `${subject} the bytes there are not the ones the previous build recorded`,
      );
      continue;
    }
    files.push({
      ...(row.domain === undefined ? {} : { domain: row.domain }),
      path: row.path,
      kind: row.kind,
      ...(row.hashed === true ? { hashed: true as const } : {}),
      contents,
    });
  }
  if (faults.length > 0) {
    throw new ConfigError(
      `Output "${input.outDir}": ${String(faults.length)} ${
        faults.length === 1 ? "file" : "files"
      } of the ${JSON.stringify(input.adapter)} search index cannot be carried from the previous build — an incremental build hands the adapter's patch the previous index as this tree holds it, so a file this tree does not hold as that build wrote it leaves an index no build wrote to patch — run pagedeck build to write the whole index again:\n${faults.join("\n")}`,
      causes.length === 0
        ? undefined
        : {
            cause:
              causes.length === 1
                ? causes[0]
                : new AggregateError(
                    causes,
                    `${String(causes.length)} files of the search index could not be read`,
                  ),
          },
    );
  }
  return files;
}

function searchRemovals(plan: IncrementalPlan): SearchRemoval[] {
  const at = (
    page: { locale: string; path: string },
    domain: string | undefined,
  ): SearchRemoval => ({
    locale: page.locale,
    path: page.path,
    ...(domain === undefined ? {} : { domain }),
  });
  return [
    ...plan.remove.map(({ page }) => at(page, page.domain)),
    ...plan.render.flatMap(({ page, reasons }) =>
      reasons.flatMap((reason) =>
        reason.kind === "moved" &&
        (reason.from.domain ?? "") !== (page.domain ?? "")
          ? [at(page, reason.from.domain)]
          : [],
      ),
    ),
  ];
}

export async function buildSite(input: BuildSiteInput): Promise<SiteBuild> {
  const section = input.config.build;
  if (section === undefined) {
    throw new ConfigError(
      `Config "${input.config.configPath}": declares no build section, so pagedeck build has no pages to render — ${MISSING_BUILD_FIX}`,
    );
  }

  const outDir = outputDir(input.config.configPath, section);
  const store = openStoreReadOnly(input.config.storePath);
  try {
    // Before a page is collected: these refusals decide whether the run can be
    // incremental at all.
    const previous =
      input.incremental === true
        ? await previousBuild({ store, outDir })
        : undefined;
    const earlier: Awaited<ReturnType<typeof prunableBuild>> =
      input.incremental === true ? {} : await prunableBuild(outDir);
    // Whatever build.links says: a reused page naming a file this build did
    // not emit would load a script or a stylesheet that is gone (#720).
    const staged = await stageUntilSettled((rerender) =>
      stageSite({
        ...input,
        section,
        store,
        outDir,
        ...(previous === undefined ? {} : { previous }),
        rerender,
      }),
    );
    await writeSite(
      outDir,
      staged.patch ?? {
        written: staged.files,
        pruned:
          earlier.previous === undefined
            ? []
            : prunedFiles(earlier.previous, staged.manifest),
        stats: {
          total: staged.pages.length,
          rendered: staged.pages.length,
          reused: 0,
          removed: 0,
        },
        redirects: [],
      },
      staged.manifest,
    );
    // Beside `outDir`, not inside it (#20): a
    // build without `build.adapter` reads neither side of this.
    await writeEdgeOutput(
      outDir,
      staged.edgeArtifacts ?? [],
      (previous ?? earlier.previous)?.edge,
    );
    // After the write, beside the tree and never inside `outDir` (spec §11,
    // #32).
    const unreadable = await retainManifest(
      dirname(input.config.configPath),
      staged.manifest,
      section.retention ?? DEFAULT_RETENTION_POLICY,
    );
    const warnings = [
      ...staged.warnings,
      ...(earlier.warning === undefined ? [] : [earlier.warning]),
      ...(unreadable === undefined ? [] : [unreadable]),
    ];
    if (warnings.length === staged.warnings.length) return staged;
    return { ...staged, warnings };
  } finally {
    store.close();
  }
}

export type StagePass<T> =
  | { kind: "built"; site: T }
  | { kind: "moved"; moved: readonly BrokenReference[] };

// Each bundle re-runs the head callbacks, social cards, renders and bundler.
const MAX_BUNDLES = 3;

export async function stageUntilSettled<T>(
  stage: (rerender: ReadonlyMap<string, string>) => Promise<StagePass<T>>,
): Promise<T> {
  const rerender = new Map<string, string>();
  for (let bundles = 1; ; bundles += 1) {
    const pass = await stage(rerender);
    if (pass.kind === "built") return pass.site;
    if (bundles === MAX_BUNDLES) {
      throw new ConfigError(movedReferenceReport(pass.moved, MAX_BUNDLES));
    }
    for (const fault of pass.moved) rerender.set(fault.page, fault.href);
  }
}

// A chunk placed in more than one tree has a row in each.
function previousSplit(previous: Manifest): ManifestChunk[] {
  const split = new Map<string, ManifestChunk>();
  for (const { chunk } of previous.files) {
    if (chunk !== undefined) split.set(JSON.stringify(chunk), chunk);
  }
  return [...split.values()];
}

function widenPlan(
  plan: IncrementalPlan,
  pages: readonly Page[],
  extra: readonly AffectedPage[],
): IncrementalPlan {
  if (extra.length === 0) return plan;
  const widened = new Set(extra.map((one) => pageKey(one.page)));
  const order = new Map(pages.map((page, index) => [pageKey(page), index]));
  const render = [...plan.render, ...extra].sort(
    (a, b) =>
      (order.get(pageKey(a.page)) ?? 0) - (order.get(pageKey(b.page)) ?? 0),
  );
  const reuse = plan.reuse.filter((one) => !widened.has(pageKey(one.page)));
  return {
    ...plan,
    render,
    reuse,
    demands: plan.demands.filter((one) => !widened.has(pageKey(one.page))),
    pinned: {
      ...plan.pinned,
      foldTuning: new Map(
        [...plan.pinned.foldTuning].filter(([key]) => !widened.has(key)),
      ),
    },
    stats: { ...plan.stats, rendered: render.length, reused: reuse.length },
  };
}

async function stageSite(input: {
  config: LoadedConfig;
  section: LoadedBuildSection;
  stamp: BuildStamp;
  store: ContentStoreReader;
  outDir: string;
  previous?: Manifest;
  rerender: ReadonlyMap<string, string>;
}): Promise<StagePass<SiteBuild>> {
  const { config, section, store } = input;
  let faviconBytes: Uint8Array | undefined;
  if (section.favicon !== undefined) {
    const src = resolve(dirname(config.configPath), section.favicon.src);
    if (!existsSync(src)) {
      throw new ConfigError(
        `Config "${config.configPath}": "build.favicon" names a source file that does not exist — ${JSON.stringify(src)} — ${MISSING_FAVICON_FIX}`,
      );
    }
    faviconBytes = await readFile(src);
  }

  const passthrough =
    section.passthrough === undefined
      ? undefined
      : await passthroughSources(config, section.passthrough);

  // The stamp's instant, not a second clock read: the manifest and the due
  // entries must agree.
  const pages = collectPages(store, section.pages, input.stamp.createdAt);
  const notFound = notFoundPages(section.routing, section.pages.trailingSlash);

  const planned =
    input.previous === undefined
      ? undefined
      : planIncremental({
          previous: input.previous,
          pages,
          notFound,
          delta: readDelta(
            store,
            input.previous,
            publicationChanges(
              store,
              input.previous,
              config.collections,
              input.stamp.createdAt,
            ),
          ),
        });

  // Before any render or carry: the only cure for a stale document is to render
  // its page (#281).
  const crossed =
    planned === undefined
      ? undefined
      : widenPlan(
          planned,
          pages,
          crossPageAffected({
            plan: planned,
            alternates: section.origin !== undefined,
            speculation: section.speculation !== undefined,
          }),
        );

  const fonts =
    section.fonts === undefined
      ? undefined
      : await fontFiles({
          config,
          setting: section.fonts,
          locales: section.pages.locales,
          pages: pages.map((page) => ({ locale: page.locale, path: page.path })),
        });

  const search = section.search;
  const wholeIndex: WholeIndex | undefined =
    crossed === undefined || input.previous === undefined || search === undefined
      ? undefined
      : search.patch === undefined
        ? { kind: "unpatched-index", adapter: search.name }
        : input.previous.files.some((file) => file.search === search.name)
          ? undefined
          : { kind: "no-previous-index", adapter: search.name };
  const indexed =
    crossed === undefined || wholeIndex === undefined
      ? crossed
      : widenPlan(
          crossed,
          pages,
          crossed.reuse.map(({ page }) => ({ page, reasons: [wholeIndex] })),
        );

  const scoped =
    indexed === undefined || input.previous === undefined
      ? indexed
      : widenPlan(
          indexed,
          pages,
          fontScopeAffected({
            previous: input.previous,
            sheets: fonts?.sheets ?? [],
            reuse: indexed.reuse,
          }),
        );
  const incremental =
    scoped === undefined
      ? scoped
      : widenPlan(
          scoped,
          pages,
          scoped.reuse.flatMap(({ page }) => {
            const href = input.rerender.get(pageKey(page));
            return href === undefined
              ? []
              : [{ page, reasons: [{ kind: "chunk-moved" as const, href }] }];
          }),
        );

  // Before any render: a tree short of a document refuses the incremental run.
  const carried =
    incremental === undefined || input.previous === undefined
      ? new Map<string, EmittedFile>()
      : await carryDocuments({
          outDir: input.outDir,
          previous: input.previous,
          reuse: incremental.reuse,
        });

  const patching =
    incremental === undefined ||
    input.previous === undefined ||
    search?.patch === undefined ||
    wholeIndex !== undefined
      ? undefined
      : {
          previous: await carrySearchIndex({
            outDir: input.outDir,
            previous: input.previous,
            adapter: search.name,
          }),
          removed: searchRemovals(incremental),
        };

  const foldStrategy = resolveFoldStrategy(section.foldStrategy);

  // Before the renders: the client build is downstream of them (#167).
  const globalCss = (section.css ?? []).map((path) =>
    resolve(dirname(config.configPath), path),
  );
  const { facts, clientComponents, warnings } = await scanIslandFacts({
    root: dirname(config.configPath),
    origin: config.configPath,
    modules: section.componentModules,
    components: section.components,
    css: globalCss,
  });

  const previewEntry =
    section.preview === undefined
      ? undefined
      : planPreview(section.components, {
          modules: section.componentModules,
          facts,
          ...(section.rootProviders === undefined
            ? {}
            : { providers: section.rootProviders.module }),
          ...(section.preview.bridge === undefined
            ? {}
            : { bridge: section.preview.bridge }),
        });

  // Sequential in page order, so a site's callback sees one order on every
  // build (spec §11).
  const heads = new Map<string, PageHead>();
  if (section.head !== undefined) {
    for (const page of pages) {
      const head = await section.head(page, store);
      if (head !== undefined) heads.set(`${page.locale} ${page.path}`, head);
    }
  }

  // After `heads`, since a card draws the title, and before `renderAll`, since
  // components read their card (#574).
  const keptCards =
    section.socialImages === undefined ||
    incremental === undefined ||
    input.previous === undefined
      ? undefined
      : await carriedCards({
          outDir: input.outDir,
          previous: input.previous,
          locales: section.pages.locales,
          documents: carried,
        });
  const socialImages =
    section.socialImages === undefined
      ? undefined
      : await socialImageFiles({
          config,
          setting: section.socialImages,
          pages,
          locales: section.pages.locales,
          heads,
          store,
          ...(incremental === undefined
            ? {}
            : {
                reused: new Set(
                  incremental.reuse.map(({ page }) => pageLabel(page)),
                ),
              }),
          ...(keptCards === undefined ? {} : { carried: keptCards }),
        });

  // Outside the reference install, which imports boundary modules that may
  // import CSS (#22).
  const stylesheets = installStylesheetStubs();
  let rendered: readonly RenderedRow[];
  try {
    // Between the scan and the renders, and closed however the renders end
    // (#168).
    const references = await installClientReferences({
      clientComponents,
      registry: section.components,
    });
    try {
      rendered = await renderAll(
        incremental === undefined
          ? pages
          : incremental.render.map((one) => one.page),
        section,
        store,
        facts,
        foldStrategy,
        socialImages?.cards,
      );
    } finally {
      references.close();
    }
  } finally {
    stylesheets.close();
  }
  const rendersDemand = rendered.map(
    ({ page, islands }) => ({ page, islands }) as PageDemand,
  );
  const plan = planEntries(
    // Every page on both kinds of build, so the bundler stays a full-graph pass
    // (spec §11).
    incremental === undefined
      ? rendersDemand
      : mergeDemands(incremental.demands, rendersDemand),
    {
      modules: section.componentModules,
      ...(section.rootProviders === undefined
        ? {}
        : {
            providers: section.rootProviders.module,
            providersDigest: rootProviderStackDigest(
              section.rootProviders.stack,
            ),
          }),
    },
  );
  const tiers =
    incremental === undefined
      ? planTiers({
          entries: plan.entries,
          ranking: store.rankUsage(),
          ...(section.tierPolicy === undefined
            ? {}
            : { policy: section.tierPolicy }),
        })
      : incremental.pinned.tiers;

  const client = await buildClient({
    root: dirname(config.configPath),
    origin: config.configPath,
    plan,
    tiers,
    globalCss,
    ...(section.vite?.plugins === undefined
      ? {}
      : { plugins: section.vite.plugins }),
    ...(incremental === undefined || input.previous === undefined
      ? {}
      : { split: previousSplit(input.previous) }),
  });

  const previewBundle =
    previewEntry === undefined
      ? undefined
      : await buildPreview({
          root: dirname(config.configPath),
          origin: config.configPath,
          path: (section.preview as PreviewSetting).path,
          entry: previewEntry,
          ...(section.vite?.plugins === undefined
            ? {}
            : { plugins: section.vite.plugins }),
        });

  const workerFallback = workerFallbackWarning(section.scripts);

  const workerConsent = workerConsentWarning(section.scripts);

  const identities = pages.map((page) => ({
    locale: page.locale,
    path: page.path,
  }));

  const unloadedScript = unloadedScriptWarning(section.scripts, identities);

  const undeclaredHeaders = undeclaredHeadersWarning(section.routing);

  const scriptByPage = new Map<string, string>();
  const preloadsByPage = new Map<string, readonly string[]>();
  const stylesByPage = new Map<string, readonly string[]>();
  for (const entry of plan.entries) {
    const script = client.entryScripts.get(entry.name);
    if (script !== undefined) {
      scriptByPage.set(`${entry.locale} ${entry.path}`, script);
      preloadsByPage.set(
        `${entry.locale} ${entry.path}`,
        staticImportClosure(script, client.imports),
      );
    }
    const styles = client.entryStyles.get(entry.name);
    if (styles !== undefined) {
      stylesByPage.set(`${entry.locale} ${entry.path}`, styles);
    }
  }

  const inlining = inlinedPages(section.criticalCss ?? {}, pages);
  const pageStyles = new Map<string, PageStyles>(
    pages.map((page) => {
      const key = `${page.locale} ${page.path}`;
      const styles = [
        ...new Set([
          ...(fonts === undefined ? [] : pageFonts(fonts, page).styles),
          ...client.globalStyles,
          ...(stylesByPage.get(key) ?? []),
        ]),
      ];
      return [
        key,
        inlining.has(key)
          ? { linked: [], inlined: styles }
          : { linked: styles, inlined: [] },
      ];
    }),
  );
  const inlineTags =
    inlining.size === 0
      ? new Map<string, readonly string[]>()
      : inlineStyleElements(
          styleSet(pageStyles, (styles) => styles.inlined),
          emittedCss(client, fonts),
        );

  const indexable = pages.filter((page) => !notFound(page));
  const alternates = localeAlternates(indexable);

  const speculation =
    section.speculation === undefined
      ? new Map<string, string>()
      : speculationRules({ setting: section.speculation, pages });

  const renderedByKey = new Map(
    rendered.map((row) => [`${row.page.locale} ${row.page.path}`, row]),
  );

  const affectedByKey = new Map<string, AffectedPage>(
    (incremental?.render ?? []).map((one) => [pageKey(one.page), one]),
  );
  const drift =
    incremental === undefined
      ? undefined
      : checkDrift({
          pinned: incremental.pinned.classes,
          // The render fragment, never the emitted document: an inlined
          // stylesheet would read as drift.
          rendered: rendered.map((row) => ({
            affected: affectedByKey.get(
              `${row.page.locale} ${row.page.path}`,
            ) as AffectedPage,
            html: renderedMarkup(row),
          })),
          ...(section.driftThreshold === undefined
            ? {}
            : { threshold: section.driftThreshold }),
          ...(section.safelist === undefined
            ? {}
            : { safelist: section.safelist }),
        });
  const supplements =
    drift === undefined
      ? undefined
      : await compileSupplements({
          report: drift,
          ...(section.driftSupplement === undefined
            ? {}
            : { compile: section.driftSupplement }),
        });
  const carriedFiles = new Set<EmittedFile>();
  for (const card of keptCards?.values() ?? []) carriedFiles.add(card);
  const documents = pages.map((page) => {
    const key = `${page.locale} ${page.path}`;
    const document = carried.get(key);
    if (document !== undefined) {
      carriedFiles.add(document);
      return { key, page, file: document };
    }
    const { html, absorbed, chrome } = renderedByKey.get(key) as RenderedRow;
    const card = socialImages?.cards.get(key);
    return {
      key,
      page,
      file: documentFile({
        page,
        html,
        absorbed,
        ...(chrome === undefined ? {} : { chrome }),
        script: scriptByPage.get(key),
        modulePreloads: preloadsByPage.get(key) ?? [],
        styles: pageStyles.get(key)?.linked ?? [],
        inlineStyles: inlineTags.get(key) ?? [],
        head:
          card === undefined
            ? heads.get(key)
            : {
                ...heads.get(key),
                image:
                  section.origin === undefined
                    ? card.href
                    : variantUrl(section.origin, {
                        ...(page.declaredDomain === undefined
                          ? {}
                          : { declaredDomain: page.declaredDomain }),
                        output: card.href,
                      }),
              },
        ...(card === undefined
          ? {}
          : { socialImage: { width: card.width, height: card.height } }),
        ...(fonts === undefined ? {} : { fontPreloads: pageFonts(fonts, page).preloads }),
        speculation: speculation.get(key),
        supplement: supplements?.styles.get(key),
        ...(notFound(page)
          ? { links: undefined, noindex: true }
          : {
              links: pageLinks({
                origin: section.origin,
                xDefault: section.xDefault,
                page,
                variants: alternates.get(page.path) ?? [],
              }),
            }),
        section,
      }),
    };
  });
  const foldTuning = new Map<string, readonly FoldAdjustment[]>(
    incremental?.pinned.foldTuning,
  );
  const foldCauses = new Map<string, readonly string[]>();
  if (foldStrategy !== undefined) {
    for (const [key, adjustments] of foldTuning) {
      foldCauses.set(
        key,
        adjustments.map((adjustment) => foldCause(adjustment, foldStrategy)),
      );
    }
    for (const { page, foldTuning: adjustments } of rendered) {
      if (adjustments.length === 0) continue;
      const key = `${page.locale} ${page.path}`;
      foldTuning.set(key, adjustments);
      foldCauses.set(
        key,
        adjustments.map((adjustment) => foldCause(adjustment, foldStrategy)),
      );
    }
  }

  const files: EmittedFile[] = [
    ...placeClientFiles({
      files: client.files,
      entryScripts: client.entryScripts,
      entries: plan.entries,
      pages,
    }),
    ...documents.map(({ file }) => file),
    ...documents
      .filter(({ page }) => notFound(page))
      .map(({ file }) => notFoundFile(file)),
    ...(fonts?.files ?? []),
    ...(socialImages?.files ?? []),
  ];

  if (section.sitemap !== undefined && section.origin !== undefined) {
    const keptSitemaps =
      incremental === undefined || input.previous === undefined
        ? undefined
        : await carrySitemaps({
            outDir: input.outDir,
            previous: input.previous,
            plan: incremental,
            pages,
            pattern: section.sitemap.pattern,
            locales: section.pages.locales,
          });
    for (const file of keptSitemaps?.values() ?? []) carriedFiles.add(file);
    files.push(
      ...sitemapFiles({
        setting: section.sitemap,
        origin: section.origin,
        xDefault: section.xDefault,
        locales: section.pages.locales,
        pages: indexable,
        ...(keptSitemaps === undefined ? {} : { carried: keptSitemaps }),
        alternates,
        emitted: files,
      }),
    );
  }

  if (section.feed !== undefined && section.origin !== undefined) {
    files.push(
      ...feedFiles({
        setting: section.feed,
        origin: section.origin,
        store,
        pages,
        locales: section.pages.locales,
        emitted: files,
      }),
    );
  }

  if (faviconBytes !== undefined) {
    files.push(
      ...faviconFiles({
        bytes: faviconBytes,
        locales: section.pages.locales,
        emitted: files,
      }),
    );
  }

  if (section.robots !== undefined) {
    files.push(
      ...robotsFiles({
        setting: section.robots,
        origin: section.origin,
        sitemaps: section.sitemap !== undefined,
        locales: section.pages.locales,
        emitted: files,
      }),
    );
  }

  if (previewBundle !== undefined && section.preview !== undefined) {
    files.push(
      ...previewFiles({
        setting: section.preview,
        bundle: previewBundle,
        locales: section.pages.locales,
        emitted: files,
      }),
    );
  }

  const sources = new Map<EmittedFile, string>();
  if (passthrough?.root !== undefined) {
    const published = passthroughFiles({
      field: "root",
      root: passthrough.root,
      files: passthrough.files,
      locales: section.pages.locales,
      emitted: files,
    });
    nameSources(sources, published, passthrough.root, passthrough.files);
    files.push(...published);
  }

  const absentFavicon = absentFaviconWarning(section.favicon !== undefined, files);

  const referenced = contentRelativeReferences({
    documents: files,
    emitted: files,
    pages,
    trailingSlash: section.pages.trailingSlash,
  });
  const undeclaredContentRoot =
    passthrough?.contentRoot === undefined
      ? undeclaredContentRootWarning(referenced)
      : undefined;
  if (passthrough?.contentRoot !== undefined) {
    const contentRoot = passthrough.contentRoot;
    const found: PassthroughSource[] = [];
    const unresolved: string[] = [];
    for (const reference of referenced) {
      const src = join(contentRoot, ...reference.address.slice(1).split("/"));
      if (!existsSync(src) || !statSync(src).isFile()) {
        unresolved.push(contentReferenceLine(reference));
        continue;
      }
      found.push({ src, bytes: await readFile(src) });
    }
    if (unresolved.length > 0) {
      throw new ConfigError(
        `Passthrough: ${String(unresolved.length)} ${
          unresolved.length === 1
            ? "reference a page makes to a file beside its content resolves"
            : "references a page makes to a file beside its content resolve"
        } to nothing this build can publish — ${UNRESOLVED_REFERENCE_FIX}:\n${unresolved.join("\n")}`,
      );
    }
    const published = passthroughFiles({
      field: "contentRoot",
      root: contentRoot,
      files: found,
      locales: section.pages.locales,
      emitted: files,
    });
    nameSources(sources, published, contentRoot, found);
    files.push(...published);
  }

  const searchKeys = new Set<string>();
  if (section.search !== undefined) {
    const searchable = searchDocuments(
      rendered.map(({ page, html }) => {
        const title = heads.get(`${page.locale} ${page.path}`)?.title;
        return { page, html, ...(title === undefined ? {} : { title }) };
      }),
    );
    const indexFiles: EmittedFile[] = [];
    if (patching === undefined) {
      indexFiles.push(
        ...(await searchFiles({
          adapter: section.search,
          documents: searchable,
          emitted: files,
        })),
      );
    } else {
      const patched = await searchPatchFiles({
        adapter: section.search,
        previous: patching.previous,
        documents: searchable,
        removed: patching.removed,
        emitted: files,
      });
      for (const file of patched.carried) carriedFiles.add(file);
      indexFiles.push(...patched.written, ...patched.carried);
    }
    for (const file of indexFiles) searchKeys.add(fileKey(file.domain, file.path));
    files.push(...indexFiles);
  }
  const undeployable = deployKeyReport(files, sources);
  if (undeployable !== undefined) throw new ConfigError(undeployable);
  const pathCollisions = pathCollisionReport(files);
  if (pathCollisions !== undefined) throw new ConfigError(pathCollisions);
  // Planned before the link check, which resolves redirects against it.
  const routing = planRouting({
    pages,
    trailingSlash: section.pages.trailingSlash,
    config: section.routing,
    emitted: files,
    ...(incremental === undefined
      ? {}
      : { removals: incremental.redirects }),
  });
  // After routing is planned and before the build reports success (#20): the
  // adapter reads the full document, incremental or not, and a refusal throws
  // the `ConfigError` `defineAdapter` built, with every fault.
  const edge =
    section.adapter === undefined
      ? undefined
      : { name: section.adapter.name, output: section.adapter.compile(routing) };
  if (edge !== undefined) files.push(...adapterTreeFiles(edge.output));
  // Read off the routing document, not `section.routing`, so the tree and the
  // manifest agree.
  const splits = new Map<string, readonly { name: string }[]>();
  for (const tree of routing.trees) {
    for (const experiment of tree.experiments ?? [])
      splits.set(fileKey(tree.domain, experiment.path), experiment.variants);
  }
  const experimentVariants = new Map<string, readonly ManifestVariant[]>();
  for (const { key, page, file } of documents) {
    const split = splits.get(fileKey(page.domain, page.output));
    if (split === undefined) continue;
    experimentVariants.set(
      key,
      split.map((arm) => {
        const document: EmittedFile = {
          ...(page.domain === undefined ? {} : { domain: page.domain }),
          path: variantPath(arm.name, file.path),
          kind: "html",
          contents: file.contents,
        };
        files.push(document);
        // Written on every build, a carried primary's arms included: nothing
        // verified their bytes (#281).
        return { name: arm.name, html: fileKey(page.domain, document.path) };
      }),
    );
  }
  if (input.previous !== undefined) {
    const moved = movedReferences({
      reused: [...carried.values()],
      emitted: files,
      routing,
      previous: new Set(
        input.previous.files
          .filter((file) => file.kind === "js" || file.kind === "css")
          .map((file) => file.path),
      ),
    });
    if (moved.length > 0) return { kind: "moved", moved };
  }
  const resolvedLinkCheck = resolveLinkCheck(section.links);
  const linkCheck =
    resolvedLinkCheck === undefined || input.previous === undefined
      ? resolvedLinkCheck
      : { broken: resolvedLinkCheck.broken };
  const linkNotes =
    linkCheck === undefined
      ? []
      : await checkSiteLinks({ files, routing, check: linkCheck });

  const propsLimit = islandPropsLimit(section.islandPropsBudget);
  const islandProps = new Map(
    documents.map(({ key, file }) => [
      key,
      weighIslandProps(textOf(file.contents), propsLimit.limit),
    ]),
  );
  if (
    section.budget !== undefined ||
    section.criticalCss !== undefined ||
    [...islandProps.values()].some((page) => page.breaches.length > 0)
  ) {
    const report = planBudgets({
      build: input.stamp,
      islandProps: { ...propsLimit, byPage: islandProps },
      budget: section.budget ?? {},
      inlinedPages: inlining,
      pages: identities,
      entryChunkByPage: scriptByPage,
      eagerChunksByPage: eagerChunksByPage(plan, client),
      chunks: budgetChunks(client),
      stylesheetsByPage: styleSet(pageStyles, (styles) => styles.linked),
      inlinedStylesheetsByPage: styleSet(pageStyles, (styles) => styles.inlined),
      stylesheets: budgetStylesheets(client),
      inlinedScriptBytesByPage: inlinedScriptBytes(documents),
      causesByPage: foldCauses,
      htmlBytesByPage: new Map(
        documents.map(({ key, file }) => [key, brotliBytes(file.contents)]),
      ),
    });
    // The site root, not `outDir`: a host publishes the output tree wholesale
    // (#336).
    await writeBudgetReport(dirname(input.config.configPath), report);
    checkBudgets(report);
  }

  const manifest = buildManifest({
    build: input.stamp,
    store: { seq: store.getLastSeq() },
    ...(drift?.fullRebuild === undefined
      ? {}
      : { fullRebuild: drift.fullRebuild }),
    site: { trailingSlash: section.pages.trailingSlash },
    routing,
    pages,
    entries: plan,
    tiers,
    classes:
      incremental === undefined
        ? rendered.flatMap((row) => classesOfHtml(renderedMarkup(row)))
        : incremental.pinned.classes,
    foldTuning,
    variants: experimentVariants,
    inlineScriptHashes: inlineScriptHashes(documents),
    noindex: new Set(
      pages.filter((page) => notFound(page)).map((page) => pageKey(page)),
    ),
    ...(section.search === undefined
      ? {}
      : { search: { adapter: section.search.name, files: searchKeys } }),
    ...(edge === undefined
      ? {}
      : {
          edge: {
            target: edge.name,
            files: adapterEdgeArtifacts(edge.output).map((artifact) => ({
              ...(artifact.domain === undefined ? {} : { domain: artifact.domain }),
              path: artifact.path,
            })),
          },
        }),
    outputs: files,
  });

  return {
    kind: "built",
    site: {
      outDir: input.outDir,
      pages,
      entries: plan,
      tiers,
      files,
      manifest,
      ...(edge === undefined
        ? {}
        : { edgeArtifacts: adapterEdgeArtifacts(edge.output) }),
      ...(incremental === undefined || input.previous === undefined
        ? {}
        : {
            patch: {
              written: files.filter((file) => !carriedFiles.has(file)),
              pruned: prunedFiles(input.previous, manifest),
              stats: incremental.stats,
              redirects: incremental.redirects,
              ...(wholeIndex === undefined ? {} : { wholeIndex }),
            },
          }),
      // A fixed order (spec §11): the scan's warnings, then this build's.
      warnings: [
        ...warnings,
        ...client.warnings,
        ...(workerFallback === undefined ? [] : [workerFallback]),
        ...(workerConsent === undefined ? [] : [workerConsent]),
        ...(unloadedScript === undefined ? [] : [unloadedScript]),
        ...(undeclaredHeaders === undefined ? [] : [undeclaredHeaders]),
        ...(undeclaredContentRoot === undefined ? [] : [undeclaredContentRoot]),
        ...(absentFavicon === undefined ? [] : [absentFavicon]),
        ...linkNotes,
        ...(drift === undefined ? [] : driftWarnings(drift)),
        ...(supplements?.warnings ?? []),
      ],
    },
  };
}

/** Static imports only: a chunk behind `import()` waits for its trigger (#95). */
function staticImportClosure(
  entry: string,
  imports: ReadonlyMap<string, readonly string[]>,
): string[] {
  const seen = new Set<string>([entry]);
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    for (const next of imports.get(path) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}

/**
 * Here, not in `budgets.ts`: it needs `ClientBuild`, which imports Vite, and
 * `budgets.ts` is reachable from the package index.
 */
function budgetChunks(client: ClientBuild): BudgetChunk[] {
  return client.files
    .filter((file) => file.kind === "js")
    .map((file) => ({
      path: file.path,
      imports: client.imports.get(file.path) ?? [],
      bytes: brotliBytes(file.contents),
    }));
}

function budgetStylesheets(client: ClientBuild): BudgetStylesheet[] {
  return client.files
    .filter((file) => file.kind === "css")
    .map((file) => ({ path: file.path, bytes: brotliBytes(file.contents) }));
}

const INLINE_SCRIPT = /<script>[\s\S]*?<\/script>/g;

function inlinedScriptBytes(
  documents: readonly { key: string; file: EmittedFile }[],
): Map<string, number> {
  const bytes = new Map<string, number>();
  for (const { key, file } of documents) {
    const inlined = textOf(file.contents).match(INLINE_SCRIPT);
    if (inlined === null) continue;
    bytes.set(key, brotliBytes(inlined.join("\n")));
  }
  return bytes;
}

function inlineScriptHashes(
  documents: readonly { key: string; file: EmittedFile }[],
): Map<string, readonly string[]> {
  const hashes = new Map<string, readonly string[]>();
  for (const { key, file } of documents) {
    const texts = coreInlineScripts(textOf(file.contents));
    if (texts.length === 0) continue;
    const sources = texts.map((text) => {
      const digest = createHash("sha256").update(text, "utf8").digest("base64");
      return `'sha256-${digest}'`;
    });
    hashes.set(key, [...new Set(sources)]);
  }
  return hashes;
}

const HEAD_TOKEN =
  /<(script|style)\b((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/\1>|<\/head>|<[a-zA-Z](?:[^>"]|"[^"]*")*>/g;

export function coreInlineScripts(document: string): string[] {
  const texts: string[] = [];
  for (const [token, tag, attributes = "", text = ""] of document.matchAll(
    HEAD_TOKEN,
  )) {
    if (token === "</head>") break;
    if (
      tag === "script" &&
      (attributes === "" || attributes === ' type="speculationrules"')
    ) {
      texts.push(text);
    }
  }
  const foot: string[] = [];
  let end = document.lastIndexOf("\n</body>");
  for (const recognizes of [isBeaconText, isScriptLoaderText]) {
    const close = end - "</script>".length;
    if (close < 0 || !document.startsWith("</script>", close)) break;
    const open = document.lastIndexOf("<script>", close);
    if (open < 0) break;
    const text = document.slice(open + "<script>".length, close);
    if (text.includes("</script>") || !recognizes(text)) continue;
    foot.unshift(text);
    end = open - 1;
  }
  return [...texts, ...foot];
}

function brotliBytes(contents: string | Uint8Array): number {
  return brotliCompressSync(
    typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
  ).byteLength;
}

export function eagerChunksByPage(
  plan: EntryPlan,
  client: ClientBuild,
): Map<string, readonly string[]> {
  const chunkByModule = new Map<string, string>();
  for (const [path, ids] of client.modules) {
    for (const id of ids) chunkByModule.set(id, path);
  }

  const byPage = new Map<string, readonly string[]>();
  const unheld: string[] = [];
  for (const entry of plan.entries) {
    const chunks = new Set<string>();
    for (const component of entry.components) {
      if (!component.eager) continue;
      const id = client.ids[component.module];
      if (id === undefined) continue;
      const chunk = chunkByModule.get(id);
      if (chunk === undefined) {
        unheld.push(
          `  ${entry.locale} ${entry.path} "${component.name}" — "${component.module}" resolved to "${id}"`,
        );
        continue;
      }
      chunks.add(chunk);
    }
    // Charged though a page with no eager island imports them on a trigger: a
    // budget counts what a page downloads, not when.
    for (const specifier of runtimeImports(entry)) {
      const id = client.ids[specifier];
      const chunk = id === undefined ? undefined : chunkByModule.get(id);
      if (chunk !== undefined) chunks.add(chunk);
    }
    if (chunks.size > 0) byPage.set(`${entry.locale} ${entry.path}`, [...chunks]);
  }
  if (unheld.length > 0) {
    throw new ConfigError(
      `JavaScript budget: ${String(unheld.length)} ${
        unheld.length === 1
          ? "eagerly hydrated island resolved to a module no emitted chunk holds, so the page it is on would be charged nothing for it"
          : "eagerly hydrated islands resolved to a module no emitted chunk holds, so the pages they are on would be charged nothing for them"
      } — ${UNHELD_FIX}:\n${unheld.join("\n")}`,
    );
  }
  return byPage;
}

async function writeBudgetReport(
  root: string,
  report: BudgetReport,
): Promise<void> {
  const file = budgetReportPath(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, budgetReportJson(report));
}

interface RenderedRow {
  page: Page;
  html: string;
  absorbed: readonly AbsorbedMetadata[];
  islands: readonly IslandInstance[];
  foldTuning: readonly FoldAdjustment[];
  chrome?: ChromeMarkup;
}

function renderedMarkup(row: RenderedRow): string {
  return row.chrome === undefined
    ? row.html
    : `${row.chrome.before}${row.html}${row.chrome.after}`;
}

/** Sequential rather than concurrent, by decision (#351). */
async function renderAll(
  pages: readonly Page[],
  section: LoadedBuildSection,
  store: ContentStoreReader,
  modules: Readonly<Record<string, ModuleFacts>>,
  foldStrategy: FoldStrategy | undefined,
  cards: ReadonlyMap<string, SocialCard> | undefined,
): Promise<readonly RenderedRow[]> {
  const rows: RenderedRow[] = [];
  const layouts = layoutContents(pages, store, section.components);
  for (const page of pages) {
    const content = await contentOf(page, layouts, store, section.content);
    const chrome = await section.chrome?.(page, store);
    const locale = section.pages.locales.get(page.locale);
    const card = cards?.get(pageLabel(page));
    const result = await renderPage({
      ...content,
      ...(chrome === undefined ? {} : { chrome }),
      page: { locale: page.locale, path: page.path },
      ...(locale === undefined ? {} : { locale }),
      ...(card === undefined ? {} : { socialCard: card }),
      registry: section.components,
      ...(section.rootProviders === undefined
        ? {}
        : { providers: section.rootProviders.stack }),
      modules,
      ...(foldStrategy === undefined ? {} : { foldStrategy }),
    });
    rows.push({
      page,
      html: result.html,
      absorbed: result.absorbed,
      islands: result.islands.map((island) => ({
        component: island.component,
        mode: island.mode,
      })),
      foldTuning: result.islands.flatMap((island) =>
        island.foldAdjustment === undefined ? [] : [island.foldAdjustment],
      ),
      ...(result.chrome === undefined ? {} : { chrome: result.chrome }),
    });
  }
  return rows;
}

interface PageStyles {
  linked: readonly string[];
  inlined: readonly string[];
}

function styleSet(
  pageStyles: ReadonlyMap<string, PageStyles>,
  half: (styles: PageStyles) => readonly string[],
): Map<string, readonly string[]> {
  return new Map([...pageStyles].map(([key, styles]) => [key, half(styles)]));
}

function emittedCss(
  client: ClientBuild,
  fonts: FontStage | undefined,
): Map<string, string> {
  return new Map(
    [...client.files, ...(fonts?.files ?? [])]
      .filter((file) => file.kind === "css")
      .map((file) => [file.path, textOf(file.contents)]),
  );
}

const FONT_MAGIC: readonly {
  readonly magic: readonly number[];
  readonly format: string;
}[] = [
  { magic: [0x77, 0x4f, 0x46, 0x32], format: "woff2" },
  { magic: [0x77, 0x4f, 0x46, 0x46], format: "woff" },
  { magic: [0x4f, 0x54, 0x54, 0x4f], format: "otf" },
  { magic: [0x00, 0x01, 0x00, 0x00], format: "ttf" },
  { magic: [0x74, 0x72, 0x75, 0x65], format: "ttf" },
];

function sniffFontFormat(bytes: Uint8Array): string | undefined {
  return FONT_MAGIC.find((one) =>
    one.magic.every((byte, index) => bytes[index] === byte),
  )?.format;
}

function fontSlug(face: FontFace): string {
  const family = face.family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${family}-${String(face.weight)}-${face.style}`;
}

function faceLabel(face: FontFace, index: number): string {
  return `faces[${String(index)}] (${JSON.stringify(face.family)})`;
}

const MISSING_FONT_FIX =
  "point src at each face's real font file, or remove the declaration";

const UNMATCHED_FONT_PAGES_FIX =
  "correct each to a page this build routes, or remove it";

const DUPLICATE_FONT_FIX =
  'declare the face once, and list every page it belongs on in its "pages"';

const FONT_HASH_LENGTH = 8;

interface PassthroughStage {
  readonly root?: string;
  readonly files: readonly PassthroughSource[];
  readonly contentRoot?: string;
}

function nameSources(
  sources: Map<EmittedFile, string>,
  published: readonly EmittedFile[],
  root: string,
  files: readonly PassthroughSource[],
): void {
  const at = new Map(files.map((file) => [passthroughAddress(root, file.src), file.src]));
  for (const file of published) {
    const src = at.get(file.path);
    if (src !== undefined) sources.set(file, src);
  }
}

async function passthroughSources(
  config: LoadedConfig,
  setting: PassthroughSetting,
): Promise<PassthroughStage> {
  const root =
    setting.root === undefined
      ? undefined
      : passthroughDirectory(
          config,
          "root",
          setting.root,
          setting.contentRoot === undefined,
        );
  const contentRoot =
    setting.contentRoot === undefined
      ? undefined
      : passthroughDirectory(
          config,
          "contentRoot",
          setting.contentRoot,
          setting.root === undefined,
        );
  const files: PassthroughSource[] = [];
  const entries =
    root === undefined
      ? []
      : await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = join(entry.parentPath, entry.name);
    files.push({ src, bytes: await readFile(src) });
  }
  return {
    files,
    ...(root === undefined ? {} : { root }),
    ...(contentRoot === undefined ? {} : { contentRoot }),
  };
}

function passthroughDirectory(
  config: LoadedConfig,
  field: "root" | "contentRoot",
  declared: string,
  alone: boolean,
): string {
  const directory = resolve(dirname(config.configPath), declared);
  const fix = `${
    field === "root" ? MISSING_PASSTHROUGH_FIX : MISSING_CONTENT_ROOT_FIX
  }, or remove ${alone ? "passthrough" : field}`;
  if (!existsSync(directory)) {
    throw new ConfigError(
      `Config "${config.configPath}": "build.passthrough.${field}" names a directory that does not exist — ${JSON.stringify(directory)} — ${fix}`,
    );
  }
  if (!statSync(directory).isDirectory()) {
    throw new ConfigError(
      `Config "${config.configPath}": "build.passthrough.${field}" names a path that is not a directory — ${JSON.stringify(directory)} — ${fix}`,
    );
  }
  return directory;
}

interface FontSheet {
  readonly href: string;
  readonly pages: readonly string[] | undefined;
}

interface FontStage {
  readonly files: readonly EmittedFile[];
  readonly sheets: readonly FontSheet[];
  readonly preloads: readonly { readonly sheet: number; readonly link: string }[];
}

function pageFonts(
  stage: FontStage,
  page: PageIdentity,
): { readonly styles: readonly string[]; readonly preloads: readonly string[] } {
  const linked = stage.sheets.map(
    (sheet) =>
      sheet.pages === undefined ||
      matchingPattern(parsePatterns(sheet.pages), page) !== undefined,
  );
  return {
    styles: stage.sheets.filter((_, index) => linked[index]).map((sheet) => sheet.href),
    preloads: stage.preloads
      .filter((preload) => linked[preload.sheet])
      .map((preload) => preload.link),
  };
}

function fontScopeAffected(input: {
  previous: Manifest;
  sheets: readonly FontSheet[];
  reuse: readonly ReusedPage[];
}): AffectedPage[] {
  const scoped = (
    rows: readonly { sheet: string; pages: readonly string[] | undefined }[],
  ): Map<string, { sheet: string; pages: readonly string[] }> =>
    new Map(
      rows.flatMap(({ sheet, pages }) =>
        pages === undefined
          ? []
          : [[`${sheet} ${JSON.stringify(pages)}`, { sheet, pages }] as const],
      ),
    );
  const before = scoped(
    input.previous.files.map((file) => ({ sheet: file.path, pages: file.fontPages })),
  );
  const now = scoped(input.sheets.map((sheet) => ({ sheet: sheet.href, pages: sheet.pages })));
  const changed = [
    ...[...before].filter(([key]) => !now.has(key)),
    ...[...now].filter(([key]) => !before.has(key)),
  ].map(([, { sheet, pages }]) => ({ sheet, patterns: parsePatterns(pages) }));
  if (changed.length === 0) return [];
  return input.reuse.flatMap(({ page }) => {
    const reasons = changed
      .filter(({ patterns }) => matchingPattern(patterns, page) !== undefined)
      .map(({ sheet }) => ({ kind: "font-scope" as const, sheet }));
    return reasons.length === 0 ? [] : [{ page, reasons }];
  });
}

async function fontFiles(input: {
  config: LoadedConfig;
  setting: FontsSetting;
  locales: LocaleSet;
  pages: readonly PageIdentity[];
}): Promise<FontStage> {
  const { config, setting, locales } = input;
  if (setting.faces.length === 0) {
    return { files: [], sheets: [], preloads: [] };
  }
  const root = dirname(config.configPath);
  const resolved = setting.faces.map((face, index) => ({
    face,
    index,
    src: resolve(root, face.src),
  }));
  const sections: string[] = [];
  const where = `Config "${config.configPath}": "build.fonts.faces"`;

  const missing = resolved.filter(({ src }) => !existsSync(src));
  if (missing.length > 0) {
    sections.push(
      `${where} declares ${String(missing.length)} ${
        missing.length === 1 ? "face" : "faces"
      } whose source file does not exist — ${MISSING_FONT_FIX}:\n${missing
        .map(
          ({ face, index, src }) =>
            `  ${faceLabel(face, index)} — ${JSON.stringify(src)} does not exist`,
        )
        .join("\n")}`,
    );
  }

  const copies = new Map<string, { face: FontFace; index: number }[]>();
  for (const { face, index, src } of resolved) {
    const key = JSON.stringify([face.family, face.weight, face.style, src, face.unicodeRanges]);
    copies.set(key, [...(copies.get(key) ?? []), { face, index }]);
  }
  const repeated = [...copies.values()].filter((group) => group.length > 1);
  if (repeated.length > 0) {
    sections.push(
      `${where} declares ${
        repeated.length === 1 ? "1 face" : `${String(repeated.length)} faces`
      } more than once, and every copy would write the same subset file — ${DUPLICATE_FONT_FIX}:\n${repeated
        .map(
          (group) =>
            `  ${group.map(({ face, index }) => faceLabel(face, index)).join(", ")}`,
        )
        .join("\n")}`,
    );
  }

  const unmatched = resolved.flatMap(({ face, index }) =>
    (face.pages ?? [])
      .filter((key) =>
        input.pages.every((page) => matchingPattern(parsePatterns([key]), page) === undefined),
      )
      .map((key) => `  ${faceLabel(face, index)} — ${JSON.stringify(key)}`),
  );
  if (unmatched.length > 0) {
    sections.push(
      `${where} declares ${
        unmatched.length === 1
          ? "1 page pattern that matches no page of this build"
          : `${String(unmatched.length)} page patterns that match no page of this build`
      } — ${UNMATCHED_FONT_PAGES_FIX}:\n${unmatched.join("\n")}`,
    );
  }
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));

  // `""`, not `undefined`: `sort` moves `undefined` last without calling the
  // comparator.
  const trees = new Set<string>();
  for (const locale of locales.values()) trees.add(localeTree(locale) ?? "");
  const domains = [...trees].sort();

  const pagesOf = (face: FontFace): string[] | undefined =>
    face.pages === undefined ? undefined : [...new Set(face.pages)].sort();
  const scopeOf = (face: FontFace): string =>
    face.pages === undefined ? "" : JSON.stringify(pagesOf(face));
  const groups = new Map<string, { pages: readonly string[] | undefined; rules: string[] }>();
  if (resolved.some(({ face }) => face.pages === undefined)) {
    groups.set("", { pages: undefined, rules: [] });
  }
  for (const { face } of resolved) {
    if (!groups.has(scopeOf(face))) {
      groups.set(scopeOf(face), { pages: pagesOf(face), rules: [] });
    }
  }
  const order = [...groups.keys()];

  const files: EmittedFile[] = [];
  const preloads: { sheet: number; link: string }[] = [];
  for (const { face, index, src } of resolved) {
    const group = groups.get(scopeOf(face)) as { rules: string[] };
    const rules = group.rules;
    let result: FontSubsetResult;
    try {
      result = await setting.adapter.subset({
        family: face.family,
        src,
        unicodeRanges: face.unicodeRanges,
      });
    } catch (cause) {
      // Unwrapped: `isWiringFault` never walks `cause`, so a wrapped
      // `ConfigError` would exit 1.
      throw cause instanceof ConfigError
        ? cause
        : new Error(
            `Font subset: the ${JSON.stringify(setting.adapter.name)} adapter threw while subsetting ${faceLabel(face, index)} — fix the adapter, or remove "build.fonts" until it can subset this face`,
            { cause },
          );
    }
    const format = sniffFontFormat(result.bytes);
    const href = `/fonts/${fontSlug(face)}.${shortHash(result.bytes, FONT_HASH_LENGTH)}${
      format === undefined ? "" : `.${format}`
    }`;
    for (const domain of domains) {
      files.push({
        ...(domain === "" ? {} : { domain }),
        path: href,
        kind: "asset",
        hashed: true,
        contents: result.bytes,
      });
    }

    rules.push(fontFaceRule(face, href));
    for (const family of face.fallback) {
      const metrics = fallbackMetricsFor(family, face.fallbackMetrics);
      if (metrics === undefined) continue;
      rules.push(
        fallbackFontFaceRule({
          family,
          weight: face.weight,
          style: face.style,
          webFont: result.metrics,
          fallback: metrics,
        }),
      );
    }
    const preload = fontPreloadLink(face, href);
    if (preload !== undefined) {
      preloads.push({ sheet: order.indexOf(scopeOf(face)), link: preload });
    }
  }

  const sheets: FontSheet[] = [];
  for (const [scope, { pages, rules }] of groups) {
    const css = rules.join("\n\n");
    const href = `/fonts/fonts.${shortHash(
      pages === undefined ? css : `${scope}\n${css}`,
      FONT_HASH_LENGTH,
    )}.css`;
    for (const domain of domains) {
      files.push({
        ...(domain === "" ? {} : { domain }),
        path: href,
        kind: "css",
        hashed: true,
        ...(pages === undefined ? {} : { fontPages: pages }),
        contents: css,
      });
    }
    sheets.push({ href, pages });
  }

  return { files, sheets, preloads };
}

interface SocialImageStage {
  readonly files: readonly EmittedFile[];
  readonly cards: ReadonlyMap<string, SocialCard>;
}

const IMAGE_MAGIC: readonly {
  readonly format: string;
  readonly magic: readonly {
    readonly at: number;
    readonly bytes: readonly number[];
  }[];
}[] = [
  { format: "png", magic: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }] },
  { format: "jpg", magic: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  // `RIFF` alone is any container, a `.wav` too; the FourCC at offset 8 says
  // WebP.
  {
    format: "webp",
    magic: [
      { at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
];

function sniffImageFormat(bytes: Uint8Array): string | undefined {
  return IMAGE_MAGIC.find((one) =>
    one.magic.every((run) =>
      run.bytes.every((byte, index) => bytes[run.at + index] === byte),
    ),
  )?.format;
}

const SOCIAL_HASH_LENGTH = FONT_HASH_LENGTH;

const SOCIAL_DIR = "/social/";

function socialSlug(page: Page): string {
  const slug = `${page.locale}${page.path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "index" : slug;
}

function pageLabel(page: Page): string {
  return `${page.locale} ${page.path}`;
}

const DOUBLE_IMAGE_FIX =
  'return undefined from "build.socialImages.inputs" for each page below, or stop declaring image for it in "build.head"';

const CARD_REFERENCE = /<meta property="og:image" content="([^"]*)">/;

function cardPath(reference: string | undefined): string | undefined {
  if (reference === undefined || reference.startsWith("/")) return reference;
  return URL.canParse(reference) ? new URL(reference).pathname : undefined;
}

async function carriedCards(input: {
  outDir: string;
  previous: Manifest;
  locales: LocaleSet;
  documents: ReadonlyMap<string, EmittedFile>;
}): Promise<ReadonlyMap<string, EmittedFile>> {
  const trees = new Set<string>();
  for (const locale of input.locales.values()) {
    trees.add(localeTree(locale) ?? "");
  }
  const rows = new Map<string, ManifestFile[]>();
  for (const file of input.previous.files) {
    if (!trees.has(file.domain ?? "")) continue;
    const group = rows.get(file.path);
    if (group === undefined) rows.set(file.path, [file]);
    else group.push(file);
  }
  const carried = new Map<string, EmittedFile>();
  const seen = new Set<string>();
  for (const document of input.documents.values()) {
    const href = cardPath(CARD_REFERENCE.exec(textOf(document.contents))?.[1]);
    if (href === undefined || !href.startsWith(SOCIAL_DIR)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    for (const row of rows.get(href) ?? []) {
      let contents: Uint8Array;
      try {
        contents = await readFile(
          join(input.outDir, row.domain ?? "", row.path),
        );
      } catch {
        continue;
      }
      if (fileHash(contents) !== row.hash) continue;
      carried.set(fileKey(row.domain, row.path), {
        ...(row.domain === undefined ? {} : { domain: row.domain }),
        path: row.path,
        kind: row.kind,
        ...(row.hashed === true ? { hashed: true as const } : {}),
        contents,
      });
    }
  }
  return carried;
}

async function socialImageFiles(input: {
  config: LoadedConfig;
  setting: SocialImagesSetting;
  pages: readonly Page[];
  locales: LocaleSet;
  heads: ReadonlyMap<string, PageHead>;
  store: ContentStoreReader;
  reused?: ReadonlySet<string>;
  carried?: ReadonlyMap<string, EmittedFile>;
}): Promise<SocialImageStage> {
  const { config, setting, pages, locales, heads, store, reused, carried } =
    input;
  // `""`, not `undefined`: `sort` moves `undefined` last without calling the
  // comparator.
  const trees = new Set<string>();
  for (const locale of locales.values()) trees.add(localeTree(locale) ?? "");
  const domains = [...trees].sort();
  const files: EmittedFile[] = [...(carried?.values() ?? [])];
  const cards = new Map<string, SocialCard>();

  const asked: {
    page: Page;
    key: string;
    inputs: SocialImageInputs;
    head: PageHead | undefined;
  }[] = [];
  const doubled: string[] = [];
  for (const page of pages) {
    const key = pageLabel(page);
    if (reused?.has(key) === true) continue;
    const inputs = await setting.inputs(page, store);
    if (inputs === undefined) continue;

    const head = heads.get(key);
    if (head?.image !== undefined) {
      doubled.push(
        `  "${key}" — "build.head" declared ${JSON.stringify(quotedValue(head.image))}`,
      );
      continue;
    }
    asked.push({ page, key, inputs, head });
  }
  if (doubled.length > 0) {
    throw new ConfigError(
      `Config "${config.configPath}": "build.socialImages" draws a card for ${String(doubled.length)} ${
        doubled.length === 1 ? "page" : "pages"
      } that "build.head" declares an image for too — ${DOUBLE_IMAGE_FIX}:\n${doubled.join("\n")}`,
    );
  }

  for (const { page, key, inputs, head } of asked) {
    let result: SocialImageResult;
    try {
      result = await setting.adapter.draw({
        page,
        title: head?.title,
        inputs,
      });
    } catch (cause) {
      throw cause instanceof ConfigError
        ? cause
        : new Error(
            `Social image: the ${JSON.stringify(setting.adapter.name)} adapter threw while drawing the card for ${JSON.stringify(key)} — fix the adapter, or remove "build.socialImages" until it can draw this page`,
            { cause },
          );
    }

    const format = sniffImageFormat(result.bytes);
    const href = `${SOCIAL_DIR}${socialSlug(page)}.${shortHash(result.bytes, SOCIAL_HASH_LENGTH)}${
      format === undefined ? "" : `.${format}`
    }`;
    for (const domain of domains) {
      files.push({
        ...(domain === "" ? {} : { domain }),
        path: href,
        kind: "asset",
        hashed: true,
        contents: result.bytes,
      });
    }
    cards.set(key, { href, width: result.width, height: result.height });
  }

  return { files, cards };
}

function documentFile(input: DocumentInput): EmittedFile {
  const base = input.page.output.replace(/\/+$/, "");
  return {
    ...(input.page.domain === undefined ? {} : { domain: input.page.domain }),
    path: `${base}/index.html`,
    kind: "html",
    page: { locale: input.page.locale, path: input.page.path },
    contents: documentHtml(input),
  };
}

// Untagged: a host reads this at every missing path, but it is not this page's
// one HTML file, so tagging it would contest `documentFile`'s own claim (#21).
function notFoundFile(document: EmittedFile): EmittedFile {
  return {
    ...(document.domain === undefined ? {} : { domain: document.domain }),
    path: "/404.html",
    kind: "html",
    contents: document.contents,
  };
}

interface DocumentInput {
  page: Page;
  html: string;
  absorbed: readonly AbsorbedMetadata[];
  chrome?: ChromeMarkup;
  script: string | undefined;
  modulePreloads?: readonly string[];
  styles: readonly string[];
  inlineStyles: readonly string[];
  head: PageHead | undefined;
  socialImage?: SocialImageDimensions;
  links: PageLinks | undefined;
  noindex?: boolean;
  fontPreloads?: readonly string[];
  speculation?: string;
  supplement?: string;
  section: LoadedBuildSection;
}

export function documentHtml(input: DocumentInput): string {
  const {
    page,
    html,
    absorbed,
    chrome,
    script,
    modulePreloads,
    styles,
    inlineStyles,
    head,
    socialImage,
    links,
    noindex,
    fontPreloads,
    speculation,
    supplement,
    section,
  } = input;
  const locale = section.pages.locales.get(page.locale);
  const conflicts = absorbedHeadConflicts({
    entry: entryId(page),
    head,
    ...(socialImage === undefined ? {} : { socialImage }),
    absorbed,
  });
  if (conflicts !== undefined) throw new RenderError(conflicts);
  if (
    chrome !== undefined &&
    mainLandmarks(`${chrome.before}${chrome.after}`) > 0
  ) {
    throw new RenderError(chromeLandmarkReport(entryId(page)));
  }
  const beacon = beaconElement(section.beacon, section.scripts, page);
  const layer = scriptElements(section.scripts, page);
  const mounted = mountFacades(
    entryId(page),
    html,
    layer.placeholders,
    chrome === undefined ? "" : `${chrome.before}${chrome.after}`,
  );
  const document = [
    "<!doctype html>",
    `<html lang="${escapeAttributeValue(page.locale)}" dir="${escapeAttributeValue(locale?.direction ?? "ltr")}">`,
    "<head>",
    ...headElements({
      head,
      ...(socialImage === undefined ? {} : { socialImage }),
      styles,
      inlineStyles,
      links,
      ...(noindex === undefined ? {} : { noindex }),
      ...(section.feed === undefined || section.origin === undefined
        ? {}
        : {
            feed: {
              href: feedUrl(section.origin),
              title: section.feed.title,
            },
          }),
      ...(fontPreloads === undefined ? {} : { fontPreloads }),
      ...(modulePreloads === undefined ? {} : { modulePreloads }),
      ...(section.prePaint === undefined ? {} : { prePaint: section.prePaint }),
      absorbed,
      ...(supplement === undefined ? {} : { supplement }),
      viewTransition: section.viewTransitions === true,
      ...(speculation === undefined ? {} : { speculation }),
    }),
    "</head>",
    "<body>",
    ...(chrome === undefined || chrome.before === "" ? [] : [chrome.before]),
    "<main>",
    mounted.html,
    ...mounted.trailing,
    "</main>",
    ...(chrome === undefined || chrome.after === "" ? [] : [chrome.after]),
    ...(script === undefined
      ? []
      : [
          `<script type="module" src="${escapeAttributeValue(script)}"></script>`,
        ]),
    ...layer.elements,
    ...(beacon === undefined ? [] : [beacon]),
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const landmarks = mainLandmarks(document);
  if (landmarks > 1) {
    throw new RenderError(landmarkReport(entryId(page), landmarks));
  }
  return document;
}

function mountFacades(
  entry: string,
  html: string,
  placeholders: readonly FacadePlaceholder[],
  chrome: string,
): { html: string; trailing: readonly string[] } {
  const trailing: string[] = [];
  const mounted: { mount: string; html: string; name: string }[] = [];
  for (const placeholder of placeholders) {
    if (placeholder.mount === undefined) trailing.push(placeholder.html);
    else mounted.push({ ...placeholder, mount: placeholder.mount });
  }
  if (mounted.length === 0) return { html, trailing };

  const offsets = mountOffsets(
    html,
    new Set(mounted.map(({ mount }) => mount)),
  );
  const missing: { name: string; mount: string }[] = [];
  const insertions: { at: number; html: string }[] = [];
  for (const facade of mounted) {
    const at = offsets.get(facade.mount);
    if (at === undefined) missing.push(facade);
    else insertions.push({ at, html: facade.html });
  }
  if (missing.length > 0) {
    const inChrome = mountOffsets(
      chrome,
      new Set(missing.map(({ mount }) => mount)),
    );
    const absent = missing.filter(({ mount }) => !inChrome.has(mount));
    const chromed = missing.filter(({ mount }) => inChrome.has(mount));
    throw new RenderError(
      [
        ...(absent.length > 0 ? [mountReport(entry, absent)] : []),
        ...(chromed.length > 0 ? [chromeMountReport(entry, chromed)] : []),
      ].join("\n\n"),
    );
  }

  insertions.sort((one, other) => one.at - other.at);
  const parts: string[] = [];
  let copied = 0;
  for (const insertion of insertions) {
    parts.push(html.slice(copied, insertion.at), insertion.html);
    copied = insertion.at;
  }
  parts.push(html.slice(copied));
  return { html: parts.join(""), trailing };
}

function mountOffsets(
  html: string,
  ids: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  let at = 0;

  while (at < html.length && found.size < ids.size) {
    const start = html.indexOf("<", at);
    if (start === -1) break;

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
      const end = html.indexOf(">", start);
      at = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html.startsWith("</", start);
    let cursor = start + (closing ? 2 : 1);
    const nameStart = cursor;
    while (cursor < html.length && /[^\s/>]/.test(html[cursor] as string)) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      at = start + 1;
      continue;
    }

    // Attribute by attribute: a quoted value may hold a `>`.
    let id: string | undefined;
    while (cursor < html.length && html[cursor] !== ">") {
      if (/[\s/]/.test(html[cursor] as string)) {
        cursor += 1;
        continue;
      }
      const attributeStart = cursor;
      while (cursor < html.length && /[^\s/>=]/.test(html[cursor] as string)) {
        cursor += 1;
      }
      const attribute = html.slice(attributeStart, cursor).toLowerCase();
      let value: string | undefined;
      if (html[cursor] === "=") {
        cursor += 1;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const end = html.indexOf(quote, cursor);
          value = html.slice(cursor, end === -1 ? html.length : end);
          cursor = end === -1 ? html.length : end + 1;
        } else {
          const valueStart = cursor;
          while (
            cursor < html.length &&
            /[^\s>]/.test(html[cursor] as string)
          ) {
            cursor += 1;
          }
          value = html.slice(valueStart, cursor);
        }
      }
      if (attribute === "id" && value !== undefined && id === undefined) {
        id = value;
      }
    }
    at = cursor + 1;

    if (closing) continue;
    if (id !== undefined && ids.has(id) && !found.has(id)) found.set(id, at);
  }

  return found;
}

function mountReport(
  entry: string,
  missing: readonly { name: string; mount: string }[],
): string {
  const lines = missing.map(
    ({ name, mount }) =>
      `  ${JSON.stringify(name)} — no element carries id="${mount}"`,
  );
  return `Entry ${entry}: ${String(missing.length)} facade${
    missing.length === 1 ? "" : "s"
  } declare${
    missing.length === 1 ? "s" : ""
  } a mount point no element on this page carries — a facade's placeholder is emitted inside the element its mount point names, so this page has nowhere to put one; render the element, or take the script off this page with a pages or pageTypes override set to "off":\n${lines.join("\n")}`;
}

function chromeMountReport(
  entry: string,
  facades: readonly { name: string; mount: string }[],
): string {
  const lines = facades.map(
    ({ name, mount }) =>
      `  ${JSON.stringify(name)} — id="${mount}" is on an element build.chrome renders`,
  );
  return `Entry ${entry}: ${String(facades.length)} facade${
    facades.length === 1 ? "" : "s"
  } declare${
    facades.length === 1 ? "s" : ""
  } a mount point only build.chrome renders — a facade's placeholder goes inside the <main> landmark with the page's content, and the chrome is outside it; move the element carrying the id into the page tree:\n${lines.join("\n")}`;
}

function mainLandmarks(document: string): number {
  return document.match(/<main(?=[\s/>])/gi)?.length ?? 0;
}

function landmarkReport(entry: string, landmarks: number): string {
  return `Entry ${entry}: ${String(landmarks)} <main> landmarks in one document — the build writes one around the page's whole rendered tree, so a component that renders its own nests inside it and axe reports landmark-main-is-top-level; render <section>, <div> or a fragment in the component instead (CONTEXT.md, "The <main> landmark is the framework's, written once per document")`;
}

function chromeLandmarkReport(entry: string): string {
  return `Entry ${entry}: build.chrome rendered a <main> landmark — the build writes the one <main> around the page tree and places the chrome before and after it, so a landmark in the chrome is a second one and is not taken in place of the build's; render <header>, <nav>, <footer> or a <div> in the chrome instead (CONTEXT.md, "The <main> landmark is the framework's, written once per document")`;
}

function placeClientFiles(input: {
  files: readonly EmittedFile[];
  entryScripts: ReadonlyMap<string, string>;
  entries: readonly PageEntry[];
  pages: readonly Page[];
}): EmittedFile[] {
  const trees = [...new Set(input.pages.map((page) => page.domain))];
  const treeOfPage = new Map(
    input.pages.map((page) => [`${page.locale} ${page.path}`, page.domain]),
  );
  const treesOfEntryChunk = new Map<string, Set<string | undefined>>();
  for (const entry of input.entries) {
    const path = input.entryScripts.get(entry.name);
    if (path === undefined) continue;
    const tree = treeOfPage.get(`${entry.locale} ${entry.path}`);
    const seen = treesOfEntryChunk.get(path);
    if (seen === undefined) treesOfEntryChunk.set(path, new Set([tree]));
    else seen.add(tree);
  }

  const placed: EmittedFile[] = [];
  for (const file of input.files) {
    const targets = treesOfEntryChunk.get(file.path) ?? trees;
    for (const domain of targets) {
      placed.push({ ...file, ...(domain === undefined ? {} : { domain }) });
    }
  }
  return placed;
}

function prunedFiles(
  previous: Manifest,
  manifest: Manifest,
): { domain?: string; path: string }[] {
  const kept = new Set(
    manifest.files.map((file) => fileKey(file.domain, file.path)),
  );
  return previous.files
    .filter((file) => !kept.has(fileKey(file.domain, file.path)))
    .map((file) => ({
      ...(file.domain === undefined ? {} : { domain: file.domain }),
      path: file.path,
    }));
}

/**
 * Files, then the manifest, then the prune: the manifest must never name a file
 * that is not on disk (#281).
 */
async function writeSite(
  outDir: string,
  patch: SitePatch,
  manifest: Manifest,
): Promise<void> {
  for (const file of patch.written) {
    const target = join(outDir, file.domain ?? "", file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, MANIFEST_FILE), manifestJson(manifest));
  for (const file of patch.pruned) {
    await rm(join(outDir, file.domain ?? "", file.path), { force: true });
  }
}

/** Beside `outDir`, as `deploy-a-site.md` names it: `edge/<tree>/<path>` (#20). */
function edgeDir(outDir: string): string {
  return join(dirname(outDir), "edge");
}

/**
 * Every artifact `build.adapter` placed outside the output tree, written fresh on
 * every build since `compile` reads the whole routing document, not a delta; a
 * path the previous build wrote and this one did not is removed, the way
 * `writeSite` prunes the output tree.
 */
async function writeEdgeOutput(
  outDir: string,
  artifacts: readonly BuildAdapterArtifact[],
  previous: { files: readonly EdgeManifestFile[] } | undefined,
): Promise<void> {
  if (artifacts.length === 0 && previous === undefined) return;
  const dir = edgeDir(outDir);
  const byKey = new Map(
    artifacts.map((artifact) => [fileKey(artifact.domain, artifact.path), artifact]),
  );
  for (const artifact of artifacts) {
    const target = join(dir, artifact.domain ?? "", artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.contents);
  }
  for (const file of previous?.files ?? []) {
    if (byKey.has(fileKey(file.domain, file.path))) continue;
    await rm(join(dir, file.domain ?? "", file.path), { force: true });
  }
}
