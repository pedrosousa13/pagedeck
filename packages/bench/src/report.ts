// Derives only per-page cost and extrapolates nothing: a computed figure would be quoted
// back as a measurement.

/** Targets, not gates (decision 24): nothing here refuses a rung for missing one. */
export const SPEC_TARGETS = {
  fullBuild: "50,000 pages (all locales summed) on the order of 10 min",
  incremental: "incremental content build on the order of 30 s end-to-end",
  store: "200 k+ entries, proven feasible in prior art (compressed blobs)",
} as const;

export const INCREMENTAL_END_TO_END =
  "a real pagedeck build --incremental process, after pagedeck sync --incremental replayed one edited entry (#281)";

/** Copied from `docs/research/2026-08-23-astro-incremental-builds.md`, not recomputed. */
export const ASTRO_BASELINE = {
  site: "aspire.dev",
  pages: 13_275,
  seconds: 326.11,
  perPageMs: 24.6,
  source: "docs/research/2026-08-23-astro-incremental-builds.md",
} as const;

export interface Rung {
  /** Pages the generator wrote, summed across locales. */
  pages: number;
  locales: number;
  /** Of `pages`, how many carry an island and so load an entry chunk. */
  islandPages: number;
  /** Rows in the manifest the build wrote — asserted against `pages`. */
  pagesBuilt: number;
  /** Files in the manifest, so the tree's size is beside the time it took. */
  outputFiles: number;
  /**
   * Distinct generated entry chunks in that tree: one per distinct entry text
   * the pages' island sets render to, not one per islanded page (#264).
   */
  entryChunks: number;
  /** Wall clock of the `pagedeck sync` process. */
  syncMs: number;
  /** Wall clock of the `pagedeck build` process. */
  buildMs: number;
  /** Wall clock of a `pagedeck sync --incremental` process after one entry was edited. */
  incrementalSyncMs: number;
  /** Wall clock of `planIncremental` over this rung's own manifest. */
  planMs: number;
  /** Wall clock of the `pagedeck build --incremental` process: spec §16's incremental target. */
  incrementalBuildMs: number;
  /** Peak resident set of the `pagedeck build` process, in bytes (`VmHWM`, `rss.ts`). */
  buildPeakRssBytes: number;
  /** The store's size after the full `pagedeck sync`, read from the same buffer as `storeGzipBytes`. */
  storeBytes: number;
  /** That same snapshot gzipped, for spec §16's "compressed blobs" clause. */
  storeGzipBytes: number;
}

export interface ReportedRung extends Rung {
  /** Over what was built, not what was asked for. */
  perPageBuildMs: number;
}

export interface ScalingReport {
  targets: typeof SPEC_TARGETS;
  astroBaseline: typeof ASTRO_BASELINE;
  incrementalEndToEnd: { measured: true; note: string };
  rungs: readonly ReportedRung[];
}

// A shortfall divides real time by pages nothing produced, which reads as a speed-up.
export function rungShortfall(rung: Rung): string | undefined {
  if (rung.pagesBuilt === rung.pages) return undefined;
  return `Scaling rung ${String(rung.pages)} pages: the build routed ${String(rung.pagesBuilt)} of the ${String(rung.pages)} pages the generator wrote, so every per-page figure for this rung would be a wall clock divided by a page count nothing produced — check that every locale the generator wrote is declared by the config it wrote beside it`;
}

export function scalingReport(rungs: readonly Rung[]): ScalingReport {
  return {
    targets: SPEC_TARGETS,
    astroBaseline: ASTRO_BASELINE,
    incrementalEndToEnd: { measured: true, note: INCREMENTAL_END_TO_END },
    rungs: rungs.map((rung) => ({
      ...rung,
      perPageBuildMs: rung.buildMs / rung.pagesBuilt,
    })),
  };
}

function seconds(ms: number): string {
  return (ms / 1_000).toFixed(2);
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

const COLUMNS: readonly { head: string; of: (rung: ReportedRung) => string }[] = [
  { head: "pages", of: (r) => String(r.pages) },
  { head: "locales", of: (r) => String(r.locales) },
  { head: "islanded", of: (r) => String(r.islandPages) },
  { head: "sync s", of: (r) => seconds(r.syncMs) },
  { head: "build s", of: (r) => seconds(r.buildMs) },
  { head: "ms/page", of: (r) => r.perPageBuildMs.toFixed(1) },
  { head: "peak RSS MiB", of: (r) => mib(r.buildPeakRssBytes) },
  { head: "store MiB", of: (r) => mib(r.storeBytes) },
  { head: "gzip MiB", of: (r) => mib(r.storeGzipBytes) },
  { head: "inc sync s", of: (r) => seconds(r.incrementalSyncMs) },
  { head: "plan s", of: (r) => seconds(r.planMs) },
  { head: "inc build s", of: (r) => seconds(r.incrementalBuildMs) },
];

// Targets and the Astro baseline go above the table, not in it: neither is this repo's
// measurement.
export function reportText(report: ScalingReport): string {
  const rows = report.rungs.map((rung) => COLUMNS.map((column) => column.of(rung)));
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.head.length, ...rows.map((row) => (row[index] as string).length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padStart(widths[index] as number)).join("  ");

  return [
    "Scaling verification (#60), spec §16",
    "",
    `  Target, full build:  ${SPEC_TARGETS.fullBuild}`,
    `  Target, incremental: ${SPEC_TARGETS.incremental}`,
    `  Target, store:       ${SPEC_TARGETS.store}`,
    "  Design targets, not gates (decision 24): CI does not fail on them.",
    "",
    `  Astro baseline: ${ASTRO_BASELINE.site}, ${ASTRO_BASELINE.pages.toLocaleString("en-US")} pages in ${String(ASTRO_BASELINE.seconds)}s = ${String(ASTRO_BASELINE.perPageMs)} ms/page`,
    `  (${ASTRO_BASELINE.source}; that document extrapolates it to ~20 min at 50,000 pages)`,
    "",
    line(COLUMNS.map((column) => column.head)),
    ...rows.map(line),
    "",
    `  Incremental, end to end: the "inc build s" column.`,
    `  ${report.incrementalEndToEnd.note}.`,
    "  The two columns before it are its halves, kept because a rung that misses the",
    "  target is a question about where the time went: the sync that replayed the edit,",
    "  and planIncremental over this rung's own manifest.",
    "",
  ].join("\n");
}
