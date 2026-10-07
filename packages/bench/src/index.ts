export const BENCH_VERSION = "0.0.0";

export { generateSyntheticSite } from "./generate.js";
export type { SyntheticSite, SyntheticSiteOptions } from "./generate.js";
export { syntheticSiteConfig } from "./site.js";
export {
  ASTRO_BASELINE,
  INCREMENTAL_END_TO_END,
  reportText,
  rungShortfall,
  scalingReport,
  SPEC_TARGETS,
} from "./report.js";
export type { ReportedRung, Rung, ScalingReport } from "./report.js";
export { peakRssBytes } from "./rss.js";
