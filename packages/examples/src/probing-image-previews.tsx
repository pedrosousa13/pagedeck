// Example: cache a blur-up preview per image source at sync time, then paint it behind the
// `<img>` with the dominant color under it. Core ships no image decoder; the probe is yours.
import { defineCollection, openStore, syncCollection } from "@pagedeck/content";
import type { ContentStore, Loader } from "@pagedeck/content";
import { renderPage } from "@pagedeck/core";
import type { ComponentRegistry } from "@pagedeck/islands";
import { SiteImage } from "./site-components.js";

interface Gallery {
  images: readonly string[];
}

const PAGE = { locale: "en", path: "/home" } as const;

// What a site's CDN might answer for a 16-pixel-wide WebP of each asset, base64'd.
const TINY_WEBP: Record<string, string | undefined> = {
  "/uploads/hero.jpg":
    "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  // A vector logo has no useful preview; `undefined` is cached, so it is asked once.
  "/uploads/logo.svg": undefined,
};

function galleryLoader(): Loader<Gallery> {
  const id = { locale: "en", path: "home" };
  return {
    syncAll(writer) {
      writer.upsert({
        ...id,
        data: { images: ["/uploads/hero.jpg", "/uploads/logo.svg", "/uploads/hero.jpg"] },
      });
      return { changed: [id], deleted: [], cursor: 1 };
    },
    syncSince: () => ({ changed: [], deleted: [], cursor: 1 }),
  };
}

export interface ProbedPreviews {
  /** Open — the caller closes it. */
  store: ContentStore;
  probedFirst: readonly string[];
  probedAgain: readonly string[];
  html: string;
  refusal: string;
}

export async function probeImagePreviews(
  storePath: string,
): Promise<ProbedPreviews> {
  const probed: string[] = [];
  const gallery = defineCollection<Gallery>({
    name: "gallery",
    loader: galleryLoader(),
    schema: false,
    imageColors: {
      extractSources: (entry) => entry.data.images,
      probe: () => "#2f3a28",
    },
    imagePreviews: {
      extractSources: (entry) => entry.data.images,
      // A real probe fetches `https://images.example${src}?w=16&fm=webp` and base64s it.
      probe: (src) => {
        probed.push(src);
        return TINY_WEBP[src];
      },
    },
  });

  const store = openStore(storePath);
  await syncCollection(store, gallery);
  const probedFirst = [...probed];
  probed.length = 0;
  await syncCollection(store, gallery);
  const probedAgain = [...probed];

  const src = "/uploads/hero.jpg";
  const { html } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "SiteImage",
        props: {
          page: PAGE,
          alt: "The team, mid-deploy",
          image: {
            src,
            width: 2400,
            height: 1350,
            placeholderColor: store.getImageColor(src),
            placeholderPreview: store.getImagePreview(src),
          },
        },
      },
    ],
    registry: {
      SiteImage: { import: async () => ({ default: SiteImage }) },
    } satisfies ComponentRegistry,
  });

  // An SVG could carry script, so only raster types are written into a page.
  let refusal = "no error";
  const scratch = openStore(":memory:");
  try {
    await syncCollection<Gallery>(scratch, {
      name: "gallery",
      loader: galleryLoader(),
      schema: false,
      imagePreviews: {
        extractSources: (entry) => entry.data.images,
        probe: () => "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      },
    });
  } catch (error) {
    refusal = ((error as Error).cause as Error).message;
  } finally {
    scratch.close();
  }

  return { store, probedFirst, probedAgain, html, refusal };
}
