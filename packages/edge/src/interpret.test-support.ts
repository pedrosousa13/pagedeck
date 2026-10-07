import type { HeaderField } from "@pagedeck/core/routing";

import type { EdgeArtifact } from "./artifact.js";
import type { Resolution } from "./oracle.test-support.js";

export function forTree(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
): readonly EdgeArtifact[] {
  return artifacts.filter((artifact) => artifact.domain === domain);
}

export function find(
  artifacts: readonly EdgeArtifact[],
  path: string,
): EdgeArtifact | undefined {
  return artifacts.find((artifact) => artifact.path === path);
}

// Case-insensitive (RFC 9110): CloudFront keys `response.headers` in lowercase. Sorted, because
// the Fetch API's `Headers` iterates by name and field order carries no meaning.
function normalize(fields: readonly HeaderField[]): readonly HeaderField[] {
  return fields
    .map((field) => ({ name: field.name.toLowerCase(), value: field.value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function comparable(resolution: Resolution): Resolution {
  if (resolution.kind === "not-found" && !("document" in resolution)) {
    return { kind: "not-found" };
  }
  return "headers" in resolution && resolution.headers !== undefined
    ? { ...resolution, headers: normalize(resolution.headers) }
    : resolution;
}
