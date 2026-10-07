import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { syncCollection, syncCollectionSince } from "@pagedeck/content";
import type {
  Collection,
  CollectionSyncOptions,
  ContentStore,
  ContentStoreReader,
  Loader,
  StandardSchemaV1,
  SyncResult,
} from "@pagedeck/content";
import { componentFaults } from "@pagedeck/islands";
import type {
  ComponentDeclarations,
  ComponentRegistry,
  RootProvider,
} from "@pagedeck/islands";
import {
  budgetFaultReport,
  islandPropsBudgetFaultReport,
} from "./budgets.js";
import type { BudgetMap } from "./budgets.js";
import { deriveComponents } from "./components.js";
import { criticalCssFaultReport } from "./critical-css.js";
import type { CriticalCssMap } from "./critical-css.js";
import { driftThresholdFaultReport, safelistFaultReport } from "./drift.js";
import type { StylingSafelist } from "./drift.js";
import { feedFaultReport } from "./feed.js";
import type { FeedSetting } from "./feed.js";
import { faviconFaultReport } from "./favicon.js";
import type { FaviconSetting } from "./favicon.js";
import { foldStrategyFaultReport } from "./fold.js";
import type { FoldStrategySetting } from "./fold.js";
import { fontsFaultReport } from "./fonts.js";
import type { FontsSetting } from "./fonts.js";
import { socialImagesFaultReport } from "./social-image.js";
import type { SocialImagesSetting } from "./social-image.js";
import type { PageHead } from "./head.js";
import { scriptsFaultReport } from "./scripts.js";
import type { ScriptsSetting } from "./scripts.js";
import { beaconFaultReport } from "./beacon.js";
import type { BeaconSetting } from "./beacon.js";
import { adapterFaultReport } from "./build-adapter.js";
import type { BuildAdapter } from "./build-adapter.js";
import { linksFaultReport } from "./links.js";
import type { LinkCheckSetting } from "./links.js";
import { retentionFaultReport } from "./retention.js";
import type { RetentionPolicy } from "./retention.js";
import { routingFaultReport } from "./routing.js";
import type { RoutingConfig } from "./routing.js";
import { passthroughFaultReport } from "./passthrough.js";
import type { PassthroughSetting } from "./passthrough.js";
import { previewFaultReport } from "./preview.js";
import type { PreviewSetting } from "./preview.js";
import { robotsFaultReport } from "./robots.js";
import type { RobotsSetting } from "./robots.js";
import { searchFaultReport } from "./search.js";
import type { SearchAdapter } from "./search.js";
import { sitemapFaultReport } from "./sitemap.js";
import type { SitemapSetting } from "./sitemap.js";
import { prePaintFaultReport } from "./pre-paint.js";
import { speculationFaultReport } from "./speculation.js";
import type { SpeculationSetting } from "./speculation.js";
import { driftSupplementFaultReport } from "./supplement.js";
import type { SupplementCompiler } from "./supplement.js";
import { viewTransitionsFaultReport } from "./view-transitions.js";
import type { ModuleMap } from "./entries.js";
import { ConfigError } from "./exit.js";
import { definePages } from "./pages.js";
import type { Page, PageSet, PageSource } from "./pages.js";
import { quote, quoteIdentifier, redactSource } from "./quote.js";
import type { TierPolicy } from "./tiers.js";
import type { PageChrome, PageContent } from "./tree.js";
import type { PluginOption } from "vite";

export interface ConfiguredCollection {
  readonly name: string;
  readonly publishField?: string;
  readonly unpublishField?: string;
  syncAll(
    store: ContentStore,
    options?: CollectionSyncOptions,
  ): Promise<SyncResult>;
  syncSince(
    store: ContentStore,
    options?: CollectionSyncOptions,
  ): Promise<SyncResult>;
}

function erase<TOut, TIn>(
  collection: Collection<TOut, TIn>,
): ConfiguredCollection {
  return {
    name: collection.name,
    ...(collection.publishField === undefined
      ? {}
      : { publishField: collection.publishField }),
    ...(collection.unpublishField === undefined
      ? {}
      : { unpublishField: collection.unpublishField }),
    syncAll: (store, options) => syncCollection(store, collection, options),
    syncSince: (store, options) =>
      syncCollectionSince(store, collection, undefined, options),
  };
}

export interface RootProviderStack {
  readonly stack: readonly RootProvider[];
  readonly module: string;
}

export interface BuildSection {
  readonly pages: PageSet;
  readonly components: ComponentDeclarations;
  readonly rootProviders?: RootProviderStack;
  readonly safelist?: StylingSafelist;
  content?(
    page: Page,
    store: ContentStoreReader,
  ): PageContent | Promise<PageContent>;
  head?(
    page: Page,
    store: ContentStoreReader,
  ): PageHead | undefined | Promise<PageHead | undefined>;
  chrome?(
    page: Page,
    store: ContentStoreReader,
  ): PageChrome | undefined | Promise<PageChrome | undefined>;
  readonly outDir: string;
  readonly css?: readonly string[];
  readonly vite?: {
    readonly plugins?: readonly PluginOption[];
  };
  readonly tierPolicy?: Partial<TierPolicy>;
  readonly budget?: BudgetMap;
  readonly islandPropsBudget?: string;
  readonly criticalCss?: CriticalCssMap;
  readonly foldStrategy?: FoldStrategySetting;
  readonly driftThreshold?: number;
  readonly retention?: RetentionPolicy;
  readonly links?: LinkCheckSetting;
  readonly driftSupplement?: SupplementCompiler;
  readonly origin?: string;
  readonly xDefault?: string;
  readonly scripts?: ScriptsSetting;
  readonly beacon?: BeaconSetting;
  readonly search?: SearchAdapter;
  readonly adapter?: BuildAdapter;
  readonly fonts?: FontsSetting;
  readonly socialImages?: SocialImagesSetting;
  readonly routing?: RoutingConfig;
  readonly sitemap?: SitemapSetting;
  readonly feed?: FeedSetting;
  readonly favicon?: FaviconSetting;
  readonly robots?: RobotsSetting;
  readonly preview?: PreviewSetting;
  readonly passthrough?: PassthroughSetting;
  readonly speculation?: SpeculationSetting;
  readonly viewTransitions?: boolean;
  readonly prePaint?: readonly string[];
}

export interface SiteConfig {
  readonly store: string;
  readonly collections: readonly ConfiguredCollection[];
  readonly build?: BuildSection;
}

const DEFAULT_STORE = "./content.db";
const DEFAULT_OUT_DIR = "./site";

type BuildSectionInput<P extends readonly unknown[]> = Omit<
  BuildSection,
  "outDir" | "pages"
> & {
  outDir?: string;
  pages: PageSet | { [K in keyof P]: PageSource<P[K]> };
};

export function defineConfig<
  T extends readonly unknown[],
  P extends readonly unknown[],
>(config: {
  store?: string;
  collections: readonly [
    ...{
      [K in keyof T]:
        | NoInfer<Collection<T[K]>>
        | (Omit<Collection<T[K]>, "loader" | "schema"> & {
            loader: Loader<unknown>;
            schema: StandardSchemaV1<unknown, T[K]>;
          });
    },
  ];
  build?: BuildSectionInput<P>;
}): SiteConfig {
  const { build } = config;
  return {
    store: config.store ?? DEFAULT_STORE,
    collections: config.collections.map((collection) => erase(collection)),
    ...(build === undefined ? {} : { build: withBuildDefaults(build) }),
  };
}

/** A JavaScript config can pass anything, and `assertBuildSection` names it. */
function withBuildDefaults<P extends readonly unknown[]>(
  build: BuildSectionInput<P>,
): BuildSection {
  if (typeof build !== "object" || build === null) return build;
  const { pages } = build;
  return {
    ...build,
    outDir: build.outDir ?? DEFAULT_OUT_DIR,
    pages: isUnknownArray(pages) ? definePages({ sources: pages }) : pages,
  };
}

export interface LoadedBuildSection
  extends Omit<BuildSection, "components"> {
  readonly components: ComponentRegistry;
  readonly componentModules: ModuleMap;
}

export interface LoadedConfig {
  readonly configPath: string;
  readonly storePath: string;
  readonly collections: readonly ConfiguredCollection[];
  readonly build?: LoadedBuildSection;
}

async function loadBuildSection(
  section: BuildSection,
  configPath: string,
): Promise<LoadedBuildSection> {
  const { components, ...rest } = section;
  const derived = await deriveComponents(components, configPath);
  return {
    ...rest,
    components: derived.registry,
    componentModules: derived.modules,
  };
}

export function outputDir(
  configPath: string,
  section: Pick<BuildSection, "outDir">,
): string {
  return join(dirname(configPath), section.outDir);
}

const CONFIG_FILENAMES = ["pagedeck.config.ts", "pagedeck.config.js"];

/** `Array.isArray` alone narrows `unknown` to `any[]`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isConfiguredCollection(value: unknown): value is ConfiguredCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "syncAll" in value &&
    typeof value.syncAll === "function" &&
    "syncSince" in value &&
    typeof value.syncSince === "function"
  );
}

function describeCollection(value: unknown, index: number): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return `collection "${value.name}"`;
  }
  return `collections[${index}]`;
}

function assertSiteConfig(
  value: unknown,
  configPath: string,
): asserts value is SiteConfig {
  const where = `Config "${configPath}"`;
  if (
    typeof value !== "object" ||
    value === null ||
    !("store" in value) ||
    typeof value.store !== "string"
  ) {
    throw new ConfigError(
      `${where}: must default-export a config with a string "store" path — export default defineConfig({ collections })`,
    );
  }
  if (!("collections" in value) || !isUnknownArray(value.collections)) {
    throw new ConfigError(
      `${where}: must default-export a config with a "collections" array`,
    );
  }
  if (value.collections.length === 0) {
    throw new ConfigError(
      `${where}: declares no collections, so sync would do nothing — list at least one`,
    );
  }
  value.collections.forEach((collection, index) => {
    if (!isConfiguredCollection(collection)) {
      throw new ConfigError(
        `${where}: ${describeCollection(collection, index)} is not ready to sync — pass the whole config through defineConfig({ collections })`,
      );
    }
  });
  if ("build" in value && value.build !== undefined) {
    assertBuildSection(value.build, where);
  }
}

/** A JavaScript config can hand over a page set no `definePages` built. */
function sourceLayouts(pages: unknown): readonly (string | undefined)[] {
  if (typeof pages !== "object" || pages === null) return [undefined];
  if (!("layouts" in pages) || !isUnknownArray(pages.layouts)) {
    return [undefined];
  }
  return pages.layouts.map((layout) =>
    typeof layout === "string" ? layout : undefined,
  );
}

function unregisteredLayoutReport(
  layouts: readonly (string | undefined)[],
  components: object,
  where: string,
): string | undefined {
  const unregistered = layouts.flatMap((layout, index) =>
    layout === undefined || Object.hasOwn(components, layout)
      ? []
      : [`  sources[${String(index)}] — layout ${quoteIdentifier(layout)}`],
  );
  if (unregistered.length === 0) return undefined;
  const registered = Object.keys(components).sort();
  const named =
    registered.length === 0
      ? "none"
      : registered.map((name) => quoteIdentifier(name)).join(", ");
  const count =
    unregistered.length === 1
      ? "1 layout"
      : `${String(unregistered.length)} layouts`;
  return `${where}: "build.pages" names ${count} that build.components does not register — register each under build.components, or name a registered component, which are ${named}:\n${unregistered.join("\n")}`;
}

function assertBuildSection(
  value: unknown,
  where: string,
): asserts value is BuildSection {
  if (typeof value !== "object" || value === null) {
    throw new ConfigError(
      `${where}: "build" must be an object — build: { pages, components, content }`,
    );
  }
  const faults: string[] = [];
  const record = value as Record<string, unknown>;
  const has = (
    field: string,
    kind: "object" | "function" | "string",
    optional = false,
    shape = `${kind === "object" ? "an" : "a"} ${kind}`,
  ): void => {
    const declared = Object.hasOwn(record, field) ? record[field] : undefined;
    if (optional && declared === undefined) return;
    const ok =
      kind === "object"
        ? typeof declared === "object" && declared !== null
        : typeof declared === kind;
    if (!ok) {
      faults.push(
        `  "${field}" — declare it as ${shape}`,
      );
    }
  };
  has(
    "pages",
    "object",
    false,
    "a list of page sources, or as a page set from definePages",
  );
  has("components", "object");
  const layouts = sourceLayouts(record["pages"]);
  has(
    "content",
    "function",
    layouts.every((layout) => layout !== undefined),
    "a function, or name a layout on every page source",
  );
  has("outDir", "string");

  const sections: string[] = [];
  if (faults.length > 0) {
    sections.push(
      `${where}: "build" is missing ${String(faults.length)} ${
        faults.length === 1 ? "field" : "fields"
      } pagedeck build needs — declare each in the build section:\n${faults.join("\n")}`,
    );
  }
  const components = Object.hasOwn(record, "components")
    ? record["components"]
    : undefined;
  if (typeof components === "object" && components !== null) {
    const report = unregisteredLayoutReport(layouts, components, where);
    if (report !== undefined) sections.push(report);
    const unusable = componentFaults(components);
    if (unusable.length > 0) {
      sections.push(
        `${where}: "build.components" holds ${
          unusable.length === 1
            ? "1 component that is"
            : `${String(unusable.length)} components that are`
        } not usable — fix each one:\n${unusable.map((fault) => `  ${fault}`).join("\n")}`,
      );
    }
  }
  if (Object.hasOwn(record, "modules")) {
    sections.push(removedModulesReport(record["modules"], where));
  }
  const budget = Object.hasOwn(record, "budget") ? record["budget"] : undefined;
  if (budget !== undefined) {
    const report = budgetFaultReport(budget, where);
    if (report !== undefined) sections.push(report);
  }
  const islandPropsBudget = Object.hasOwn(record, "islandPropsBudget")
    ? record["islandPropsBudget"]
    : undefined;
  if (islandPropsBudget !== undefined) {
    const report = islandPropsBudgetFaultReport(islandPropsBudget, where);
    if (report !== undefined) sections.push(report);
  }
  const criticalCss = Object.hasOwn(record, "criticalCss")
    ? record["criticalCss"]
    : undefined;
  if (criticalCss !== undefined) {
    const report = criticalCssFaultReport(criticalCss, where);
    if (report !== undefined) sections.push(report);
  }
  const css = Object.hasOwn(record, "css") ? record["css"] : undefined;
  if (css !== undefined) {
    const report = cssFaultReport(css, where);
    if (report !== undefined) sections.push(report);
  }
  const vite = Object.hasOwn(record, "vite") ? record["vite"] : undefined;
  if (vite !== undefined) {
    const report = viteFaultReport(vite, where);
    if (report !== undefined) sections.push(report);
  }
  const foldStrategy = Object.hasOwn(record, "foldStrategy")
    ? record["foldStrategy"]
    : undefined;
  if (foldStrategy !== undefined) {
    const report = foldStrategyFaultReport(foldStrategy, where);
    if (report !== undefined) sections.push(report);
  }
  const driftThreshold = Object.hasOwn(record, "driftThreshold")
    ? record["driftThreshold"]
    : undefined;
  if (driftThreshold !== undefined) {
    const report = driftThresholdFaultReport(driftThreshold, where);
    if (report !== undefined) sections.push(report);
  }
  const safelist = Object.hasOwn(record, "safelist")
    ? record["safelist"]
    : undefined;
  if (safelist !== undefined) {
    const report = safelistFaultReport(safelist, where);
    if (report !== undefined) sections.push(report);
  }
  const retention = Object.hasOwn(record, "retention")
    ? record["retention"]
    : undefined;
  if (retention !== undefined) {
    const report = retentionFaultReport(retention, where);
    if (report !== undefined) sections.push(report);
  }
  const links = Object.hasOwn(record, "links") ? record["links"] : undefined;
  if (links !== undefined) {
    const report = linksFaultReport(links, where);
    if (report !== undefined) sections.push(report);
  }
  const driftSupplement = Object.hasOwn(record, "driftSupplement")
    ? record["driftSupplement"]
    : undefined;
  if (driftSupplement !== undefined) {
    const report = driftSupplementFaultReport(driftSupplement, where);
    if (report !== undefined) sections.push(report);
  }
  const rootProviders = Object.hasOwn(record, "rootProviders")
    ? record["rootProviders"]
    : undefined;
  if (rootProviders !== undefined) {
    const report = rootProvidersFaultReport(rootProviders, where);
    if (report !== undefined) sections.push(report);
  }
  const head = Object.hasOwn(record, "head") ? record["head"] : undefined;
  if (head !== undefined && typeof head !== "function") {
    sections.push(
      `${where}: "build.head" must be a function returning one page's head fields — head: (page, store) => ({ title: "…" })`,
    );
  }
  const chrome = Object.hasOwn(record, "chrome") ? record["chrome"] : undefined;
  if (chrome !== undefined && typeof chrome !== "function") {
    sections.push(
      `${where}: "build.chrome" must be a function returning one page's chrome — chrome: (page, store) => ({ before: [{ component: "Nav" }], after: [{ component: "Footer" }] })`,
    );
  }
  const origin = Object.hasOwn(record, "origin") ? record["origin"] : undefined;
  if (origin !== undefined) {
    const report = originFaultReport(origin, where);
    if (report !== undefined) sections.push(report);
  }
  const xDefault = Object.hasOwn(record, "xDefault")
    ? record["xDefault"]
    : undefined;
  if (xDefault !== undefined) {
    const pages = Object.hasOwn(record, "pages") ? record["pages"] : undefined;
    const locales =
      typeof pages === "object" && pages !== null && "locales" in pages
        ? pages.locales
        : undefined;
    const report = xDefaultFaultReport(xDefault, origin, locales, where);
    if (report !== undefined) sections.push(report);
  }
  const scripts = Object.hasOwn(record, "scripts")
    ? record["scripts"]
    : undefined;
  if (scripts !== undefined) {
    const report = scriptsFaultReport(scripts, where, "build.scripts");
    if (report !== undefined) sections.push(report);
  }
  const search = Object.hasOwn(record, "search") ? record["search"] : undefined;
  if (search !== undefined) {
    const report = searchFaultReport(search, where);
    if (report !== undefined) sections.push(report);
  }
  const adapter = Object.hasOwn(record, "adapter") ? record["adapter"] : undefined;
  if (adapter !== undefined) {
    const report = adapterFaultReport(adapter, where);
    if (report !== undefined) sections.push(report);
  }
  const fonts = Object.hasOwn(record, "fonts") ? record["fonts"] : undefined;
  if (fonts !== undefined) {
    const report = fontsFaultReport(fonts, where);
    if (report !== undefined) sections.push(report);
  }
  const socialImages = Object.hasOwn(record, "socialImages")
    ? record["socialImages"]
    : undefined;
  if (socialImages !== undefined) {
    const report = socialImagesFaultReport(socialImages, where);
    if (report !== undefined) sections.push(report);
  }
  const routing = Object.hasOwn(record, "routing")
    ? record["routing"]
    : undefined;
  if (routing !== undefined) {
    const report = routingFaultReport(routing, where);
    if (report !== undefined) sections.push(report);
  }
  const sitemap = Object.hasOwn(record, "sitemap")
    ? record["sitemap"]
    : undefined;
  if (sitemap !== undefined) {
    const report = sitemapFaultReport(sitemap, origin, where);
    if (report !== undefined) sections.push(report);
  }
  const feed = Object.hasOwn(record, "feed") ? record["feed"] : undefined;
  if (feed !== undefined) {
    const pages = Object.hasOwn(record, "pages") ? record["pages"] : undefined;
    const locales =
      typeof pages === "object" && pages !== null && "locales" in pages
        ? pages.locales
        : undefined;
    const report = feedFaultReport(feed, origin, locales, where);
    if (report !== undefined) sections.push(report);
  }
  const favicon = Object.hasOwn(record, "favicon")
    ? record["favicon"]
    : undefined;
  if (favicon !== undefined) {
    const report = faviconFaultReport(favicon, where);
    if (report !== undefined) sections.push(report);
  }
  const robots = Object.hasOwn(record, "robots") ? record["robots"] : undefined;
  if (robots !== undefined) {
    const report = robotsFaultReport(robots, where);
    if (report !== undefined) sections.push(report);
  }
  const preview = Object.hasOwn(record, "preview")
    ? record["preview"]
    : undefined;
  if (preview !== undefined) {
    const report = previewFaultReport(preview, where);
    if (report !== undefined) sections.push(report);
  }
  const passthrough = Object.hasOwn(record, "passthrough")
    ? record["passthrough"]
    : undefined;
  if (passthrough !== undefined) {
    const report = passthroughFaultReport(passthrough, where);
    if (report !== undefined) sections.push(report);
  }
  const speculation = Object.hasOwn(record, "speculation")
    ? record["speculation"]
    : undefined;
  if (speculation !== undefined) {
    const report = speculationFaultReport(speculation, where);
    if (report !== undefined) sections.push(report);
  }
  const viewTransitions = Object.hasOwn(record, "viewTransitions")
    ? record["viewTransitions"]
    : undefined;
  if (viewTransitions !== undefined) {
    const report = viewTransitionsFaultReport(viewTransitions, where);
    if (report !== undefined) sections.push(report);
  }
  const beacon = Object.hasOwn(record, "beacon") ? record["beacon"] : undefined;
  if (beacon !== undefined) {
    const report = beaconFaultReport(beacon, where);
    if (report !== undefined) sections.push(report);
  }
  const prePaint = Object.hasOwn(record, "prePaint")
    ? record["prePaint"]
    : undefined;
  if (prePaint !== undefined) {
    const report = prePaintFaultReport(prePaint, where);
    if (report !== undefined) sections.push(report);
  }
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));
}

function removedModulesReport(modules: unknown, where: string): string {
  const entries =
    typeof modules === "object" && modules !== null && !Array.isArray(modules)
      ? Object.entries(modules).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
      : [];
  if (entries.length === 0) {
    return `${where}: "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules", as components: { counter: "./components/counter.tsx" }`;
  }
  const lines = entries.map(
    ([name, path]) => `  "${name}" — ${quoteIdentifier(path)}`,
  );
  return `${where}: "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules"; it lists ${
    lines.length === 1
      ? "1 component to declare there by this path"
      : `${String(lines.length)} components to declare there by these paths`
  }:\n${lines.join("\n")}`;
}

const CSS_SHAPE_FIX = 'css: ["./styles/global.css"]';
const CSS_ENTRY_FIX =
  "write each as a path to a stylesheet, relative to this config file";
const VITE_SHAPE_FIX = "vite: { plugins: [somePlugin()] }";
const PLUGIN_FIX =
  "pass what a plugin factory returns, not the factory itself — call the factory, as plugins: [somePlugin()]";

function cssFaultReport(value: unknown, where: string): string | undefined {
  if (!isUnknownArray(value)) {
    return `${where}: "build.css" must be an array of stylesheet paths — ${CSS_SHAPE_FIX}`;
  }
  const faults = value.flatMap((entry, index) => {
    if (typeof entry !== "string")
      return [`  css[${String(index)}] — not a string`];
    if (entry.trim() === "") {
      const reason =
        entry === "" ? "the path is empty" : "the path is only whitespace";
      return [`  css[${String(index)}] — "${entry}" — ${reason}`];
    }
    return [];
  });
  if (faults.length === 0) return undefined;
  return `${where}: "build.css" declares ${String(faults.length)} ${
    faults.length === 1 ? "entry that is not a" : "entries that are not"
  } stylesheet path${faults.length === 1 ? "" : "s"} — ${CSS_ENTRY_FIX}:\n${faults.join("\n")}`;
}

function viteFaultReport(value: unknown, where: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.vite" must be an object — ${VITE_SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const plugins = Object.hasOwn(record, "plugins")
    ? record["plugins"]
    : undefined;
  if (plugins === undefined) return undefined;
  if (!isUnknownArray(plugins)) {
    return `${where}: "build.vite.plugins" must be an array of Vite plugins — ${VITE_SHAPE_FIX}`;
  }
  const faults = plugins.flatMap((plugin, index) =>
    isPluginOption(plugin)
      ? []
      : [`  plugins[${String(index)}] — not a plugin object`],
  );
  if (faults.length === 0) return undefined;
  return `${where}: "build.vite.plugins" declares ${String(faults.length)} ${
    faults.length === 1
      ? "entry that is not a Vite plugin"
      : "entries that are not Vite plugins"
  } — ${PLUGIN_FIX}:\n${faults.join("\n")}`;
}

function isPluginOption(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.every((one) => isPluginOption(one));
  if (typeof value !== "object") return false;
  if ("then" in value && typeof value.then === "function") return true;
  return "name" in value && typeof value.name === "string";
}

const ROOT_PROVIDERS_SHAPE_FIX =
  'declare both halves, as rootProviders: { stack: providers, module: "./providers.js" }';
const ROOT_PROVIDERS_STACK_FIX =
  "write the stack as an array of { component, props }, outermost first, the shape both sides apply";
const ROOT_PROVIDERS_MODULE_FIX =
  'name the module whose default export is that same stack, as module: "./providers.js"';
const ROOT_PROVIDERS_UNKNOWN_FIX =
  'delete the field, or correct it to "stack" or "module", the only fields rootProviders takes';

function rootProvidersFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.rootProviders" must be an object holding the stack and the module it is imported from — ${ROOT_PROVIDERS_SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];

  const unknown = Object.keys(record).filter(
    (key) => key !== "stack" && key !== "module",
  );
  if (unknown.length > 0) {
    const subject =
      unknown.length === 1
        ? "declares 1 field this build does not read"
        : `declares ${String(unknown.length)} fields this build does not read`;
    const lines = unknown.map((key) => `  ${JSON.stringify(key)}`).join("\n");
    sections.push(
      `${where}: "build.rootProviders" ${subject} — ${ROOT_PROVIDERS_UNKNOWN_FIX}:\n${lines}`,
    );
  }

  const stack = Object.hasOwn(record, "stack") ? record["stack"] : undefined;
  const stackFaults = stackFaultLines(stack);
  if (stackFaults.length > 0) {
    sections.push(
      `${where}: "build.rootProviders" declares a stack this build cannot apply — ${ROOT_PROVIDERS_STACK_FIX}:\n${stackFaults
        .map((fault) => `  ${fault}`)
        .join("\n")}`,
    );
  }

  const module = Object.hasOwn(record, "module") ? record["module"] : undefined;
  if (module === undefined) {
    sections.push(
      `${where}: "build.rootProviders" names no module for an island entry to import the stack from — ${ROOT_PROVIDERS_MODULE_FIX}`,
    );
  } else {
    const fault = moduleFault(module);
    if (fault !== undefined) {
      sections.push(
        `${where}: "build.rootProviders" declares a module no island entry can import — ${ROOT_PROVIDERS_MODULE_FIX}:\n  ${fault}`,
      );
    }
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function stackFaultLines(value: unknown): string[] {
  if (value === undefined) {
    return [
      `"stack" — absent, so the build-time render would wrap the page in nothing while every island root wrapped the stack`,
    ];
  }
  if (!isUnknownArray(value)) return [`"stack" — not an array of providers`];
  if (value.length === 0) {
    return [
      `"stack" — declares no providers, and a site with no stack says so by leaving "build.rootProviders" out`,
    ];
  }
  return value.flatMap((provider, index) => {
    const at = `stack[${String(index)}]`;
    if (typeof provider !== "object" || provider === null) {
      return [`${at} — not an object`];
    }
    const one = provider as Record<string, unknown>;
    const component = Object.hasOwn(one, "component")
      ? one["component"]
      : undefined;
    const props = Object.hasOwn(one, "props") ? one["props"] : undefined;
    return [
      ...(typeof component === "function" ||
      (typeof component === "object" && component !== null)
        ? []
        : [`${at}.component — not a component`]),
      ...(props === undefined ||
      (typeof props === "object" && props !== null && !Array.isArray(props))
        ? []
        : [`${at}.props — not an object`]),
    ];
  });
}

function moduleFault(value: unknown): string | undefined {
  if (typeof value !== "string") return `"module" — not a string`;
  if (value.trim() === "") {
    return `"module" — ${quote(value)} — ${
      value === "" ? "the specifier is empty" : "the specifier is only whitespace"
    }`;
  }
  return undefined;
}

const ORIGIN_FIX =
  'write the scheme and host the site is served from and nothing else, as origin: "https://example.com"';
const XDEFAULT_FIX =
  'name one of the locales declared in build.pages.locales, as xDefault: "en"';

function redactOrigin(value: string): string {
  return redactSource(value);
}

function originFaultReport(value: unknown, where: string): string | undefined {
  if (typeof value !== "string") {
    return `${where}: "build.origin" must be a string — ${ORIGIN_FIX}`;
  }
  const shown = JSON.stringify(redactOrigin(value));
  const report = (faults: readonly string[]): string =>
    `${where}: "build.origin" is not a site origin — ${ORIGIN_FIX}:\n${faults
      .map((fault) => `  ${shown} — ${fault}`)
      .join("\n")}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return report(["not an absolute URL, so it names no scheme and no host"]);
  }

  const faults: string[] = [];
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    faults.push(
      `the scheme is "${url.protocol}", and a document links to an origin a browser fetches over http: or https:`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    faults.push(
      "the origin holds userinfo, and an origin is a scheme and a host",
    );
  }
  if (url.pathname !== "/") {
    faults.push(
      `the origin holds the path "${redactOrigin(url.pathname)}", and this build appends each page's own path to it`,
    );
  } else if (value.endsWith("/")) {
    faults.push(
      "it ends in a slash, and each page's path already starts with one",
    );
  }
  if (url.search !== "") {
    faults.push(
      "the origin holds a query, and an origin is a scheme and a host",
    );
  }
  if (url.hash !== "") {
    faults.push(
      "the origin holds a fragment, and an origin is a scheme and a host",
    );
  }
  return faults.length === 0 ? undefined : report(faults);
}

function xDefaultFaultReport(
  value: unknown,
  origin: unknown,
  locales: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "string") {
    return `${where}: "build.xDefault" must be a locale code — ${XDEFAULT_FIX}`;
  }
  const sections: string[] = [];
  if (origin === undefined) {
    sections.push(
      `${where}: "build.xDefault" is declared without "build.origin", and the x-default link it names is an absolute URL — declare origin: "https://example.com", or remove xDefault`,
    );
  }
  if (locales instanceof Map && !locales.has(value)) {
    const declared = [...(locales.keys() as Iterable<unknown>)]
      .map((code) => JSON.stringify(code))
      .join(", ");
    sections.push(
      `${where}: "build.xDefault" names a locale that is not declared — declare the locale, or point xDefault at a declared locale:\n  ${JSON.stringify(value)} — the declared locales are ${declared}`,
    );
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

/**
 * Node's ESM cache never evicts, so a re-read imports under a fresh query; a
 * counter, since two saves can share a millisecond.
 */
let reloads = 0;
export const RELOAD_QUERY = "fw-reload";

export async function loadConfig(
  cwd: string,
  options: { reload?: boolean } = {},
): Promise<LoadedConfig> {
  const configPath = CONFIG_FILENAMES.map((name) => join(cwd, name)).find(
    (candidate) => existsSync(candidate),
  );
  if (configPath === undefined) {
    throw new ConfigError(
      `No config file in ${cwd} — pagedeck is run from a site directory holding one of: ${CONFIG_FILENAMES.join(", ")}`,
    );
  }

  const url = pathToFileURL(configPath);
  if (options.reload === true) {
    reloads += 1;
    url.searchParams.set(RELOAD_QUERY, String(reloads));
  }
  let module: unknown;
  try {
    module = (await import(url.href)) as unknown;
  } catch (error) {
    throw new ConfigError(`Config "${configPath}": failed to load`, {
      cause: error,
    });
  }

  if (typeof module !== "object" || module === null || !("default" in module)) {
    throw new ConfigError(
      `Config "${configPath}": has no default export — export default defineConfig({ collections })`,
    );
  }
  const config = module.default;
  assertSiteConfig(config, configPath);

  return {
    configPath,
    storePath: resolve(dirname(configPath), config.store),
    collections: config.collections,
    ...(config.build === undefined
      ? {}
      : { build: await loadBuildSection(config.build, configPath) }),
  };
}
