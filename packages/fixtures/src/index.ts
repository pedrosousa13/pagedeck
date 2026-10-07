export const FIXTURES_VERSION = "0.0.0";

export { createFixtureLoader } from "./loader.js";
export type { FixtureFile } from "./loader.js";
export { loadFixtureStore } from "./harness.js";
export type { FixtureStore, FixtureStoreOptions } from "./harness.js";
export {
  extractTreeUsage,
  PRICING_PAGE_USAGE,
  SITE_FIXTURES,
} from "./site.js";
export type {
  ComponentNode,
  FixturePage,
  TemplatePage,
  TreePage,
} from "./site.js";
