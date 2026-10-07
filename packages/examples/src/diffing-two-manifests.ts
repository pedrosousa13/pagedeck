// Example: turn two build manifests into a deploy. Walk `upload` in order, assets before HTML,
// and delete `prune` only after `prune.notBefore`.
import {
  buildManifest,
  diffManifests,
  planEntries,
  planRouting,
  planTiers,
} from "@pagedeck/core";
import type { EmittedFile, Manifest, ManifestDiff, Page } from "@pagedeck/core";

const HOME: Page = {
  locale: "en",
  path: "/",
  output: "/",
  dependencies: [],
};

// The manifest hashes `contents` itself, so no caller can hand it a digest of something else.
function manifestOf(
  id: string,
  createdAt: string,
  outputs: readonly EmittedFile[],
): Manifest {
  const entries = planEntries([{ page: HOME, islands: [] }], { modules: {} });
  return buildManifest({
    build: { id, createdAt },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [HOME], trailingSlash: "never" }),
    pages: [HOME],
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    // Required even when empty: a build that tuned nothing says so.
    foldTuning: new Map(),
    outputs,
  });
}

const BEFORE = manifestOf("build-01", "2026-08-25T10:00:00.000Z", [
  {
    path: "/index.html",
    kind: "html",
    page: { locale: "en", path: "/" },
    contents: "<!doctype html><title>Home</title>",
  },
  { path: "/assets/app-a1b2c3.js", kind: "js", contents: "console.log(1);" },
  { path: "/assets/site-9f8e7d.css", kind: "css", contents: "a{color:red}" },
]);

// The script's name carries its hash, so a new version is a new path and the old one is pruned.
const AFTER = manifestOf("build-02", "2026-08-26T09:30:00.000Z", [
  {
    path: "/index.html",
    kind: "html",
    page: { locale: "en", path: "/" },
    contents: "<!doctype html><title>Home, revised</title>",
  },
  { path: "/assets/app-d4e5f6.js", kind: "js", contents: "console.log(2);" },
  { path: "/assets/site-9f8e7d.css", kind: "css", contents: "a{color:red}" },
]);

export interface DeployPlan {
  /** The whole document, exactly what `pagedeck diff` prints. */
  diff: ManifestDiff;
  /** The upload steps a CI would run, in the order it must run them. */
  steps: string[];
  /** What to delete, and the instant it becomes safe to. */
  cleanup: { keys: string[]; notBefore: string };
}

export function planDeployFromManifests(): DeployPlan {
  // Named, not positional: swapped, they would describe a deploy that deletes the site.
  const diff = diffManifests({ from: BEFORE, to: AFTER });

  const steps: string[] = [];
  for (const tree of diff.trees) {
    // `tree.domain` is the host; absent means the default tree.
    const host = tree.domain ?? "default";
    for (const file of tree.upload) {
      // `file.path` is what to write inside the tree; never re-spell it.
      steps.push(`${host}: put ${file.path} (${file.change})`);
    }
  }

  const cleanup = {
    keys: diff.trees.flatMap((tree) => tree.prune.map((file) => file.key)),
    notBefore: diff.prune.notBefore,
  };

  return { diff, steps, cleanup };
}
