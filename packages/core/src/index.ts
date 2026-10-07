import { CONTENT_VERSION } from "@pagedeck/content";

export const CORE_VERSION = "0.1.0";

export function workspaceVersions(): { core: string; content: string } {
  return { core: CORE_VERSION, content: CONTENT_VERSION };
}

export { budgetReportPath } from "./budgets.js";
export type {
  BuildAdapter,
  BuildAdapterArtifact,
  BuildAdapterOutput,
} from "./build-adapter.js";
export { runCli } from "./cli.js";
export type { CliIo } from "./cli.js";
export { defineConfig, loadConfig } from "./config.js";
export type {
  BuildSection,
  ConfiguredCollection,
  LoadedBuildSection,
  LoadedConfig,
  RootProviderStack,
  SiteConfig,
} from "./config.js";
export { DIAGNOSTIC_MARKER } from "./diagnostic-marker.js";
export { checkDrift, DEFAULT_DRIFT_THRESHOLD, driftWarnings } from "./drift.js";
export type {
  DriftedPage,
  DriftInput,
  DriftReport,
  ReRenderedPage,
  StylingSafelist,
} from "./drift.js";
export { compileSupplements } from "./supplement.js";
export type {
  SupplementCompiler,
  SupplementInput,
  SupplementResult,
} from "./supplement.js";
export {
  DEFAULT_FOLD_THRESHOLD,
  foldPositions,
  isAboveFold,
  resolveFoldStrategy,
} from "./fold.js";
export type {
  FoldAdjustment,
  FoldPosition,
  FoldStrategy,
  FoldStrategySetting,
} from "./fold.js";
export type { JsonLdNode, JsonLdValue, PageHead } from "./head.js";
export {
  DEFAULT_IMAGE_SIZES,
  defineImages,
  imageAttributes,
  urlTemplate,
} from "./images.js";
export type {
  ImageAdapter,
  ImageAttributes,
  ImageAttributesInput,
  ImageRequest,
  ImageSource,
  ImagesSetting,
} from "./images.js";
export {
  CONSENT_ATTRIBUTE,
  CONSENT_DENIED,
  CONSENT_EVENT,
  CONSENT_GLOBAL,
  CONSENT_GRANTED,
} from "./consent.js";
export type { ConsentCategory, ConsentSource } from "./consent.js";
export {
  DEFAULT_CONSENT,
  DEFAULT_SCRIPT_STRATEGY,
  WORKER_FALLBACK_STRATEGY,
  defineScripts,
  loadedScriptStrategy,
  resolveConsentDefault,
  resolveScriptStrategy,
} from "./scripts.js";
export type {
  ConsentDefault,
  ConsentDefaultMap,
  ScriptAttributes,
  ScriptDeclaration,
  ScriptFacade,
  ScriptOverrideMap,
  ScriptRuntimeAdapter,
  ScriptRuntimeRequest,
  ScriptsSetting,
  ScriptStrategy,
} from "./scripts.js";
export { BEACON_CATEGORY } from "./beacon.js";
export type { BeaconSetting } from "./beacon.js";
export type {
  ExternalLinkSetting,
  LinkCheckSetting,
  LinkProbe,
} from "./links.js";
export type {
  SearchAdapter,
  SearchDocument,
  SearchPatch,
  SearchPatchInput,
  SearchRemoval,
} from "./search.js";
export { searchPatchFaults } from "./search.js";
export type {
  FontAdapter,
  FontFace,
  FontMetrics,
  FontsSetting,
  FontSubsetRequest,
  FontSubsetResult,
} from "./fonts.js";
export type {
  SocialImageAdapter,
  SocialImageInputs,
  SocialImageRequest,
  SocialImageResult,
  SocialImagesSetting,
} from "./social-image.js";
export type { FeedItemFields, FeedSetting } from "./feed.js";
export type { FaviconSetting } from "./favicon.js";
export type { RobotsSetting } from "./robots.js";
export type { PreviewSetting } from "./preview.js";
export type { PassthroughSetting } from "./passthrough.js";
export type { SitemapPattern, SitemapSetting } from "./sitemap.js";
export type { SpeculationAction, SpeculationSetting } from "./speculation.js";
export {
  DEFAULT_PRUNE_POLICY,
  DIFF_VERSION,
  diffJson,
  diffManifests,
  racedDeployReport,
} from "./diff.js";
export type {
  DiffFile,
  DiffInput,
  DiffStats,
  DiffTree,
  FileChange,
  ManifestDiff,
  PrunedFile,
  PrunePolicy,
  PruneWindow,
} from "./diff.js";
export { resolveBoundaries } from "./directives.js";
export type {
  BoundarySet,
  ClientBoundary,
  Directive,
  ModuleGraph,
} from "./directives.js";
export { planEntries, renderEntryModule } from "./entries.js";
export type {
  CarriedComponent,
  ContentOnlyPage,
  EntryComponent,
  EntryPlan,
  EntryText,
  IslandInstance,
  ModuleMap,
  PageDemand,
  PageEntry,
  PlanEntriesOptions,
} from "./entries.js";
export { ConfigError, describeError, EXIT_CODES } from "./exit.js";
export type { ExitCode } from "./exit.js";
export { quoteIdentifier } from "./quote.js";
export {
  crossPageAffected,
  DEFAULT_REDIRECT_POLICY,
  mergeDemands,
  pageKey,
  planIncremental,
  publicationChanges,
  readDelta,
} from "./incremental.js";
export type {
  AffectedPage,
  AffectedReason,
  BuildDelta,
  IncrementalPlan,
  IncrementalPlanInput,
  PageKey,
  RedirectPolicy,
  RedirectRecord,
  Removal,
  ReusedPage,
  ScheduledCollection,
} from "./incremental.js";
export { defineLocales } from "./locales.js";
export {
  buildManifest,
  deployKeyFault,
  fileKey,
  MANIFEST_VERSION,
  manifestJson,
  readManifest,
} from "./manifest.js";
export type {
  BuildStamp,
  EdgeManifestFile,
  EmittedFile,
  FileKind,
  FullRebuildRequest,
  Manifest,
  ManifestFile,
  ManifestInput,
  ManifestPage,
  ManifestVariant,
  SiteFacts,
  StorePosition,
} from "./manifest.js";
export type {
  Direction,
  LocaleDefinition,
  LocaleSet,
  PlacedLocale,
} from "./locales.js";
export {
  canonicalizePath,
  collectPages,
  definePages,
  fromCollection,
  fromTemplate,
  normalizeOutputPath,
  normalizeOutputPrefix,
  paginate,
  refKey,
  segments,
} from "./pages.js";
export type {
  EntryOrigin,
  EntryRef,
  Page,
  PagedList,
  PagedRoute,
  PageSet,
  PageSource,
  Paging,
  ParamsOf,
  Route,
  RouteInstance,
  SiteAddressing,
  TrailingSlash,
} from "./pages.js";
export {
  DEFAULT_RETENTION_POLICY,
  listRetainedManifests,
  readRetainedManifest,
  RETENTION_DIR,
  retainManifest,
  unusableId,
} from "./retention.js";
export type { RetentionPolicy } from "./retention.js";
export {
  planRouting,
  redirectIndex,
  ROUTING_VERSION,
  SECURITY_HEADERS,
  VARIANT_SEGMENT,
  variantPath,
} from "./routing.js";
export type {
  HeaderField,
  HeaderRule,
  NotFoundRule,
  RedirectRule,
  RedirectSource,
  RedirectStatus,
  ResolvedExperiment,
  ResolvedRedirect,
  RoutingConfig,
  RoutingInput,
  RoutingManifest,
  RoutingTree,
  VariantRule,
  WeightedVariant,
} from "./routing.js";
export { renderPage } from "./render.js";
export type {
  AbsorbedMetadata,
  HeadClaim,
  RenderPageInput,
  RenderedPage,
} from "./render.js";
export { clientReference } from "./client-reference.js";
export type { ClientReferenceOptions } from "./client-reference.js";
export {
  buildPageTree,
  RenderError,
  unescapedHtml,
  useBuildData,
  useLocale,
  useSocialCard,
} from "./tree.js";
export { SEARCH_ATTRIBUTE } from "./tree.js";
export type {
  EntryNode,
  IslandNodeElement,
  PageChrome,
  PageContent,
  PageTreeInput,
  RenderedIsland,
  RootProvider,
  SocialCard,
  WrapIsland,
} from "./tree.js";
export { planPreview, renderPreviewModule } from "./preview-entry.js";
export type {
  PlanPreviewOptions,
  PreviewComponent,
  PreviewEntry,
} from "./preview-entry.js";
export { checkPreviewGraph } from "./preview-graph.js";
export type { PreviewChunkFacts } from "./preview-graph.js";
export { localAddressKind, pullSnapshot, pushSnapshot, redactTarget } from "./snapshot.js";
export { syncSite } from "./sync.js";
export type {
  CollectionSyncFailure,
  CollectionSyncReport,
  SyncOptions,
  SyncReport,
} from "./sync.js";
export {
  assertModuleIds,
  codeSplitting,
  DEFAULT_TIER_POLICY,
  planTiers,
} from "./tiers.js";
export type {
  CodeSplittingConfig,
  ModuleIds,
  Tier,
  TierAssignment,
  TierGroup,
  TierPlan,
  TierPlanInput,
  TierPolicy,
} from "./tiers.js";
