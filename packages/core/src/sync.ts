import { openStore } from "@pagedeck/content";
import type { ContentStore } from "@pagedeck/content";
import type { ConfiguredCollection, LoadedConfig } from "./config.js";

export interface CollectionSyncReport {
  readonly collection: string;
  readonly changed: number;
  readonly deleted: number;
  readonly cursor: number;
}

export interface CollectionSyncFailure {
  readonly collection: string;
  readonly error: Error;
}

export interface SyncReport {
  readonly synced: CollectionSyncReport[];
  readonly failed: CollectionSyncFailure[];
  readonly warnings: string[];
}

export interface SyncOptions {
  readonly incremental: boolean;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function syncOne(
  store: ContentStore,
  collection: ConfiguredCollection,
  options: SyncOptions,
  onWarning: (message: string) => void,
): Promise<CollectionSyncReport> {
  const result = options.incremental
    ? await collection.syncSince(store, { onWarning })
    : await collection.syncAll(store, { onWarning });
  return {
    collection: collection.name,
    changed: result.changed.length,
    deleted: result.deleted.length,
    cursor: result.cursor,
  };
}

export async function syncSite(
  config: LoadedConfig,
  options: SyncOptions,
): Promise<SyncReport> {
  const synced: CollectionSyncReport[] = [];
  const failed: CollectionSyncFailure[] = [];
  const warnings: string[] = [];
  const store = openStore(config.storePath);

  try {
    for (const collection of config.collections) {
      try {
        synced.push(
          await syncOne(store, collection, options, (message) => {
            warnings.push(message);
          }),
        );
      } catch (error) {
        failed.push({ collection: collection.name, error: asError(error) });
      }
    }
  } finally {
    store.close();
  }

  return { synced, failed, warnings };
}
