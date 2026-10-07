import { DEPLOY_DIRECTORY } from "@pagedeck/core/routing";

/**
 * Where a target that cannot answer 404 itself sends a denied request, so it misses at the
 * origin and the 404 page serves. Nothing a build emits lands under `DEPLOY_DIRECTORY`.
 */
export const UNSERVED_KEY = `${DEPLOY_DIRECTORY}/unserved`;
