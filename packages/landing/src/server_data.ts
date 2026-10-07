import type { ContentStoreReader } from "@pagedeck/content";
import type { PageContent, PageHead, PageSource } from "@pagedeck/core";
import { SERVER_DATA_PAGE } from "./catalog.js";

export const SERVER_DATA_ROUTE = "server-data";

export const SERVER_DATA_PATH = `/${SERVER_DATA_ROUTE}/`;

const COPY = {
  title: "A large CMS entry, and the few bytes of it that ship",
  description:
    "A server component reads a whole CMS product entry at build time, renders part of it as HTML, and hands one interactive component only the fields it needs.",
  intro:
    "The server component on this page read a whole product entry from the CMS when the site was built: variants, stock, reviews, SEO fields and editorial notes. It rendered part of it as HTML and gave the one interactive component three fields. The figures say how much of the entry reached your browser as data.",
  figures: {
    read: "What the server component read: the whole entry, serialized as JSON.",
    sent: "What reached the browser as data: the variant picker's props, serialized into its island marker.",
  },
  explainer: {
    heading: "What you are looking at",
    body: [
      "The server component ran once, at build time, on the build machine. It read the whole entry, wrote the description, the specs and the review count into this page as HTML, and was never sent to your browser.",
      "The variant picker is the one interactive component. The server component renders it from its own code, and the build replaces it with a client reference that writes the island marker. Its props are the only product data on this page, serialized into that marker: the SKU, the price and each variant's id, colour and size.",
      "There is no page-level data blob. The rest of the entry, stock by warehouse, barcodes, costs, media, reviews and notes, stayed on the build machine.",
    ],
  },
} as const;

export function serverDataPageSource(): PageSource<Record<string, never>> {
  return {
    instances: (_store: ContentStoreReader) => [
      { locale: "en", params: {}, dependencies: [] },
    ],
    route: () => SERVER_DATA_ROUTE,
  };
}

export const SERVER_DATA_HEAD: PageHead = {
  title: COPY.title,
  description: COPY.description,
};

export function serverDataContent(): PageContent {
  return {
    tree: [
      {
        component: SERVER_DATA_PAGE,
        props: {
          title: COPY.title,
          intro: COPY.intro,
          figures: COPY.figures,
          explainer: COPY.explainer,
        },
      },
    ],
  };
}
