// No `build.scripts`: a script layer would carry the site's own vendor URLs, and
// the payload scan could no longer say no.
import { defineCollection } from "@pagedeck/content";
import type { CollectionWriter, SyncResult } from "@pagedeck/content";
import { defineComponents } from "@pagedeck/islands";
import {
  defineConfig,
  defineLocales,
  definePages,
  fromCollection,
} from "@pagedeck/core";
import type { SiteConfig } from "@pagedeck/core";
// By package name: Node loads this file for `pagedeck`, and a relative `.js` would
// name a file only `tsc` emits (#182).
import { components } from "@pagedeck/design-system";

const BANNER = "consent_banner";

export const BANNER_COPY = {
  heading: "Cookies on this site",
  body: "We measure how the site is used.",
  acceptLabel: "Accept all",
  rejectLabel: "Reject all",
  manageLabel: "Cookie settings",
} as const;

interface BannerEntry {
  tree: readonly {
    component: string;
    props: Record<string, string>;
    children: readonly never[];
  }[];
}

const ENTRY: BannerEntry = {
  tree: [{ component: BANNER, props: { ...BANNER_COPY }, children: [] }],
};

export function bannerSiteConfig(): SiteConfig {
  const pages = defineCollection<BannerEntry>({
    name: "pages",
    loader: {
      syncAll: (writer: CollectionWriter<BannerEntry>): SyncResult => {
        writer.upsert({ locale: "en", path: "home", data: ENTRY });
        return {
          changed: [{ locale: "en", path: "home" }],
          deleted: [],
          authoritative: true,
          cursor: 1,
        };
      },
      // Never reached, since every run syncs from a cold store; `Loader` requires it.
      syncSince: (): SyncResult => ({ changed: [], deleted: [], cursor: 1 }),
    },
    schema: false,
    extractUsage: (entry) =>
      entry.data.tree.map((node) => ({
        component: node.component,
        count: 1,
        foldScore: 0,
        depth: 0,
        isRoot: true,
      })),
  });

  return defineConfig({
    store: "./content.db",
    collections: [pages],
    build: {
      outDir: "./dist",
      pages: definePages({
        trailingSlash: "never",
        locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
        sources: [fromCollection(pages, { route: () => "/" })],
      }),
      components: defineComponents({ [BANNER]: components[BANNER] }),
      // Rolldown drops a group below `minSize`, and one island alone would leave an
      // empty core tier, which `checkClientGraph` refuses.
      tierPolicy: { minSize: 0 },
      content: () => ({ tree: [...ENTRY.tree] }),
    },
  });
}
