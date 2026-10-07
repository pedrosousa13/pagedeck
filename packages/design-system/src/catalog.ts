import { RegistryError } from "@pagedeck/islands";
import type { HydrationMode } from "@pagedeck/islands";

export const PACKAGE_NAME = "@pagedeck/design-system";

const SUBPATH_PREFIX = `${PACKAGE_NAME}/components/`;

export interface CatalogEntry {
  module: string;
  // The tests' loader: `content.test.tsx` renders each component through it, and
  // `drift.test.ts` checks it loads the module `module` names.
  import: () => Promise<unknown>;
  // Absent on every row on purpose: fold tuning promotes only a defaulted mode,
  // never a declared one (spec §8).
  hydrate?: HydrationMode;
}

export type Catalog = Readonly<Record<string, CatalogEntry>>;

export const catalog = {
  button: {
    module: `${PACKAGE_NAME}/components/button`,
    import: () => import("@pagedeck/design-system/components/button"),
  },
  consent_banner: {
    module: `${PACKAGE_NAME}/components/consent_banner`,
    import: () => import("@pagedeck/design-system/components/consent_banner"),
  },
  feature_card: {
    module: `${PACKAGE_NAME}/components/feature_card`,
    import: () => import("@pagedeck/design-system/components/feature_card"),
  },
  feature_grid: {
    module: `${PACKAGE_NAME}/components/feature_grid`,
    import: () => import("@pagedeck/design-system/components/feature_grid"),
  },
  hero: {
    module: `${PACKAGE_NAME}/components/hero`,
    import: () => import("@pagedeck/design-system/components/hero"),
  },
  landing_page: {
    module: `${PACKAGE_NAME}/components/landing_page`,
    import: () => import("@pagedeck/design-system/components/landing_page"),
  },
  legal_page: {
    module: `${PACKAGE_NAME}/components/legal_page`,
    import: () => import("@pagedeck/design-system/components/legal_page"),
  },
  pricing_page: {
    module: `${PACKAGE_NAME}/components/pricing_page`,
    import: () => import("@pagedeck/design-system/components/pricing_page"),
  },
} satisfies Catalog;

// A relative specifier would resolve against the consuming site's root and
// build green against whatever it found there.
export function refuseForeignModules(rows: Catalog): void {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(rows)) {
    if (!entry.module.startsWith(SUBPATH_PREFIX)) {
      lines.push(`  "${name}": ${entry.module}`);
    }
  }
  if (lines.length === 0) return;
  const subject =
    lines.length === 1
      ? "1 component names"
      : `${lines.length} components name`;
  throw new RegistryError(
    `Component catalog "${PACKAGE_NAME}": ${subject} a module outside the package's own subpaths, and a generated page entry resolves a specifier against the site's root, not this package's — spell each as "${SUBPATH_PREFIX}<component>":\n${lines.join("\n")}`,
  );
}
