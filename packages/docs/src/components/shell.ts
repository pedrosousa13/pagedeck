import { SEARCH_ATTRIBUTE } from "@pagedeck/core/tree";

export const WRAP = "fw-wrap";

export const PAGE = `${WRAP} fw-docs`;

export const BODY = "fw-doc";

export const UNINDEXED = { [SEARCH_ATTRIBUTE]: "ignore" } as const;
