import type {
  EmittedFile,
  SearchAdapter,
  SearchDocument,
  SearchPatch,
  SearchPatchInput,
} from "@pagedeck/core";
import { indexDocuments, patchDocuments } from "./shards.js";

/**
 * Takes no options: the build and browser halves must agree, and an option lets them differ
 * silently.
 */
export function defineSearch(): SearchAdapter {
  return {
    name: "@pagedeck/search",
    // `async`, so a refused locale is a rejected promise, not a synchronous throw.
    index: async (
      documents: readonly SearchDocument[],
    ): Promise<readonly EmittedFile[]> => indexDocuments(documents),
    patch: async (input: SearchPatchInput): Promise<SearchPatch> =>
      patchDocuments(input),
  };
}
