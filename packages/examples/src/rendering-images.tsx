// Example: turn a CMS asset into a responsive `<img>`. Core computes the attributes and the
// site owns the markup; an asset with no dimensions fails the build.
import { foldPositions, isAboveFold, renderPage } from "@pagedeck/core";
import { urlTemplate } from "@pagedeck/core/images";
import type { EntryNode } from "@pagedeck/core";
import { SiteImage } from "./site-components.js";
import type { ComponentRegistry } from "@pagedeck/islands";

const PAGE = { locale: "en", path: "/home" } as const;

// Threshold 1: a two-node page would otherwise put both images above the fold.
const FOLD = { threshold: 1 };

// What `store.getImageColor` would answer; a source with no color is absent.
const CACHED_COLORS: Record<string, string | undefined> = {
  "/uploads/hero.jpg": "#2f3a28",
};

// `width` and `height` are the asset's intrinsic pixel size, not a layout size.
const CONTENT = [
  {
    alt: "The team, mid-deploy",
    image: { src: "/uploads/hero.jpg", width: 2400, height: 1350 },
  },
  {
    alt: "A pricing table",
    image: {
      src: "/uploads/pricing.png",
      width: 800,
      height: 600,
      sizes: "320px",
    },
  },
];

// `foldPositions` numbers the nodes as hydration does; the verdict per image is the site's
// to state.
const TREE: readonly EntryNode[] = foldPositions(
  CONTENT,
  // Leaves: this entry nests nothing.
  () => undefined,
).map(({ node, position, treeSize }) => ({
  component: "SiteImage",
  props: {
    page: PAGE,
    alt: node.alt,
    image: {
      ...node.image,
      aboveFold: isAboveFold({ position, treeSize, strategy: FOLD }),
      placeholderColor: CACHED_COLORS[node.image.src],
    },
  },
}));

export interface RenderedImages {
  html: string;
  url: string;
  missingDimensions: string;
}

export async function renderSiteImages(): Promise<RenderedImages> {
  const registry = {
    SiteImage: { import: async () => ({ default: SiteImage }) },
  } satisfies ComponentRegistry;

  const { html } = await renderPage({ page: PAGE, tree: TREE, registry });

  // The adapter alone: four values in, one URL out. `imageAttributes` calls it per width.
  const adapter = urlTemplate("https://images.example{src}?w={width}&fm={format}");
  const url = adapter({
    src: "/uploads/hero.jpg",
    width: 640,
    quality: 70,
    format: "auto",
  });

  // The CLS guard: it names the page and the image and lists every missing dimension.
  let missingDimensions = "no error";
  try {
    await renderPage({
      page: PAGE,
      tree: [
        {
          component: "SiteImage",
          props: {
            page: PAGE,
            alt: "An asset nobody measured",
            image: { src: "/uploads/unmeasured.jpg" },
          },
        },
      ],
      registry,
    });
  } catch (error) {
    missingDimensions = (error as Error).message;
  }

  return { html, url, missingDimensions };
}
