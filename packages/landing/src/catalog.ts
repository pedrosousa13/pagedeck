// Only the probes and `search` declare `hydrate`, because fold tuning never
// promotes a declared mode (#24).
import { defineComponents } from "@pagedeck/islands";
import type { ComponentDeclarations } from "@pagedeck/islands";

export const LANDING_PAGE_MODULE = "@pagedeck/landing/components/landing_page";

export const ISLAND_PAGE_MODULE = "@pagedeck/landing/components/island_page";

export const COUNTER_MODULE = "@pagedeck/landing/components/counter";

export const ISLAND_PAGE = "island_page";

export const COUNTER = "counter";

export const LANDING_PAGE = "landing_page";

export const SITE_HEADER_MODULE = "@pagedeck/landing/components/site_header";
export const SITE_FOOTER_MODULE = "@pagedeck/landing/components/site_footer";
export const SITE_HEADER = "site_header";
export const SITE_FOOTER = "site_footer";

export const FEATURES_PAGE = "features_page";
export const FEATURE_SECTION = "feature_section";
export const ISLAND_LOAD = "island_load";
export const ISLAND_IDLE = "island_idle";
export const ISLAND_VISIBLE = "island_visible";
export const STATIC_PROBE = "static_probe";
export const SEARCH = "search";
export const CONSENT_BANNER = "consent_banner";
export const EMBED_FRAME = "embed_frame";
export const RESPONSIVE_IMAGE = "responsive_image";
export const FONT_SPECIMEN = "font_specimen";
export const SOCIAL_CARD = "social_card";
export const LOCALE_LINKS = "locale_links";

// Registered, because a client-reference proxy stands in only for a registered
// `"use client"` module.
export const SERVER_DATA_PAGE = "server_data_page";
export const VARIANT_PICKER = "variant_picker";

type ComponentName =
  | typeof LANDING_PAGE
  | typeof ISLAND_PAGE
  | typeof COUNTER
  | typeof SITE_HEADER
  | typeof SITE_FOOTER
  | typeof FEATURES_PAGE
  | typeof FEATURE_SECTION
  | typeof ISLAND_LOAD
  | typeof ISLAND_IDLE
  | typeof ISLAND_VISIBLE
  | typeof STATIC_PROBE
  | typeof SEARCH
  | typeof CONSENT_BANNER
  | typeof EMBED_FRAME
  | typeof RESPONSIVE_IMAGE
  | typeof FONT_SPECIMEN
  | typeof SOCIAL_CARD
  | typeof LOCALE_LINKS
  | typeof SERVER_DATA_PAGE
  | typeof VARIANT_PICKER;

export const components: ComponentDeclarations<ComponentName> =
  defineComponents({
    landing_page: LANDING_PAGE_MODULE,
    island_page: ISLAND_PAGE_MODULE,
    counter: COUNTER_MODULE,
    site_header: SITE_HEADER_MODULE,
    site_footer: SITE_FOOTER_MODULE,
    features_page: "@pagedeck/landing/components/features_page",
    feature_section: "@pagedeck/landing/components/feature_section",
    island_load: {
      path: "@pagedeck/landing/components/island_load",
      hydrate: "load",
    },
    island_idle: {
      path: "@pagedeck/landing/components/island_idle",
      hydrate: "idle",
    },
    island_visible: {
      path: "@pagedeck/landing/components/island_visible",
      hydrate: "visible",
    },
    static_probe: "@pagedeck/landing/components/static_probe",
    search: { path: "@pagedeck/search/island", hydrate: "interaction" },
    consent_banner: "@pagedeck/design-system/components/consent_banner",
    embed_frame: "@pagedeck/landing/components/embed_frame",
    responsive_image: "@pagedeck/landing/components/responsive_image",
    font_specimen: "@pagedeck/landing/components/font_specimen",
    social_card: "@pagedeck/landing/components/social_card",
    locale_links: "@pagedeck/landing/components/locale_links",
    server_data_page: "@pagedeck/landing/components/server_data_page",
    variant_picker: "@pagedeck/landing/components/variant_picker",
  });
