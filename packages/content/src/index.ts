export const CONTENT_VERSION = "0.2.0";

export {
  CollectionError,
  defineCollection,
  getEntry,
  getEntryCached,
  listDueEntries,
  listEntries,
  syncCollection,
  syncCollectionSince,
} from "./collection.js";
export type {
  Collection,
  CollectionSyncOptions,
  CollectionWriter,
  EntryId,
  ImageColorsSetting,
  Loader,
  SyncResult,
  TemplateUsage,
} from "./collection.js";
export { DEFAULT_COLOR_CONCURRENCY, syncImageColors } from "./colors.js";
export type { ImageColorProbe, SyncImageColorsInput } from "./colors.js";
export type { StandardSchemaV1 } from "@standard-schema/spec";
export { openStore, openStoreReadOnly } from "./store.js";
export type {
  ComponentRanking,
  ComponentUsage,
  ContentStore,
  ContentStoreReader,
  Entry,
  InvertedWindowEntry,
  PublishWindow,
  UsageRecord,
} from "./store.js";
