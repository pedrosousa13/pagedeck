// `search` hydrates on `idle`: hydrating it issues no request, and the
// `visible` default would hydrate it the moment it scrolled into view.
import { defineComponents } from "@pagedeck/islands";
import type { ComponentDeclarations } from "@pagedeck/islands";

export const DOC_PAGE_MODULE = "@pagedeck/docs-site/components/doc_page";

export const SEARCH_PAGE_MODULE = "@pagedeck/docs-site/components/search_page";

export const SEARCH_ISLAND_MODULE = "@pagedeck/search/island";

export const SEARCH_ISLAND = "search";

export const SEARCH_PAGE = "search_page";

export const SITE_HEADER_MODULE = "@pagedeck/docs-site/components/site_header";
export const SITE_FOOTER_MODULE = "@pagedeck/docs-site/components/site_footer";
export const SITE_HEADER = "site_header";
export const SITE_FOOTER = "site_footer";

type ComponentName =
  | "doc_page"
  | typeof SEARCH_PAGE
  | typeof SEARCH_ISLAND
  | typeof SITE_HEADER
  | typeof SITE_FOOTER;

export const components: ComponentDeclarations<ComponentName> =
  defineComponents({
    doc_page: DOC_PAGE_MODULE,
    search_page: SEARCH_PAGE_MODULE,
    search: { path: SEARCH_ISLAND_MODULE, hydrate: "idle" },
    site_header: SITE_HEADER_MODULE,
    site_footer: SITE_FOOTER_MODULE,
  });
