import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCollection, openStore, syncCollection } from "@pagedeck/content";
import type { Collection, ContentStore } from "@pagedeck/content";
import { createFixtureLoader } from "./loader.js";

export interface FixtureStoreOptions {
  directory: string;
  /** Defaults to `pages`. */
  collection?: string;
}

export interface FixtureStore<T> {
  store: ContentStore;
  collection: Collection<T>;
  storePath: string;
  // Synchronous, so it can be the whole body of an `afterEach`.
  close(): void;
}

export async function loadFixtureStore<T>(
  options: FixtureStoreOptions,
): Promise<FixtureStore<T>> {
  // A directory, so the store's journal sidecars are removed with it.
  const storeDir = mkdtempSync(join(tmpdir(), "pagedeck-fixture-store-"));
  const storePath = join(storeDir, "content.db");

  // `T` is whatever the calling test claims its fixtures hold, so there is no schema to declare.
  const collection = defineCollection<T>({
    name: options.collection ?? "pages",
    loader: createFixtureLoader<T>(options.directory),
    schema: false,
  });
  const store = openStore(storePath);
  function discard(): void {
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
  }

  try {
    await syncCollection(store, collection);
  } catch (error) {
    discard();
    throw error;
  }

  return { store, collection, storePath, close: discard };
}
