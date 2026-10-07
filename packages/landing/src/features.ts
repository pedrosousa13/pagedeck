import { join } from "node:path";
import { defineScripts } from "@pagedeck/core";
import type {
  FontsSetting,
  Page,
  PageContent,
  PageHead,
  PageSource,
  ScriptsSetting,
  SocialImagesSetting,
  EntryNode,
} from "@pagedeck/core";
import type { ContentStoreReader } from "@pagedeck/content";
import { defineImages, imageAttributes, urlTemplate } from "@pagedeck/core/images";
import type { ImagesSetting } from "@pagedeck/core/images";
import { defineFontSubset } from "@pagedeck/font-subset";
import { defineSocialImage } from "@pagedeck/social-image";
import {
  CONSENT_BANNER,
  EMBED_FRAME,
  FEATURE_SECTION,
  FEATURES_PAGE,
  FONT_SPECIMEN,
  ISLAND_IDLE,
  ISLAND_LOAD,
  ISLAND_VISIBLE,
  LOCALE_LINKS,
  RESPONSIVE_IMAGE,
  SEARCH,
  SOCIAL_CARD,
  STATIC_PROBE,
} from "./catalog.js";

export const FEATURES_ROUTE = "features";

export const FEATURES_PATH = `/${FEATURES_ROUTE}`;

const DOCS_ORIGIN = "https://docs.pagedeck.example";

const DOGFOOD_ORIGIN = "https://dogfood.example";

const PACKAGE = join(import.meta.dirname, "..");

export const PUBLIC_DIR = join(PACKAGE, "public");

// Reached by relative path, so the repository carries one copy of the font.
const FIRA_SANS = join(PACKAGE, "..", "site", "fonts", "FiraSans-Regular.ttf");

const EMBED_MOUNT = "embed-demo";

// Plain ASCII where the fonts demo sets it: the face is subset to printable
// ASCII, and anything else would fall back mid-word.
const COPY = {
  title: "Every feature, running on this page",
  description:
    "Pagedeck's features, each explained in a few sentences and running live: islands under three hydration strategies, search, a consent-gated embed, responsive images, a subset font, a social card and locales.",
  intro:
    "Each section says what one feature does and then runs it here. The islands hydrate, the search box searches, and the embed waits for your consent. The only JavaScript on this page belongs to the islands it demonstrates.",
  islands: {
    heading: "Islands and hydration",
    body: [
      'A component marked "use client" is rendered to HTML at build time and then hydrated in the browser. Its registry row says when: load hydrates as soon as the page\'s script runs, idle waits until the browser has nothing else to do, and visible waits until the component scrolls into view.',
      'Each box shows when it hydrated, counted from the moment the page opened. The last box is the same component without "use client". It gets no island marker and no script, so its text never changes.',
    ],
    docs: "Fold strategy: how hydration modes are tuned",
    waiting: "Server HTML. Not hydrated yet.",
    hydrated: "Hydrated {seconds} s after the page opened.",
    staticWaiting: "Server HTML. It ships no JavaScript, so it never hydrates.",
  },
  search: {
    heading: "Search",
    body: [
      "At build time, @pagedeck/search indexes the text of every page on this site into a few small static files. The box is an island that hydrates on idle and fetches nothing until you focus it.",
      'Try "island", "budget" or "consent".',
    ],
    docs: "Site search",
    label: "Search this site",
    emptyLabel: "No page on this site matches that.",
  },
  consent: {
    heading: "Consent-gated embeds",
    body: [
      "A third-party embed is declared as a script with the facade strategy and a consent category. The page ships a button in its place. Pressing the button loads the script, and only if the category is granted.",
      "Here the embed is a small script on this site's own origin, standing in for a vendor's, so the demo contacts nobody. The panel is the reference consent banner. Press the button first to see the gate refuse, then accept and press it again.",
    ],
    docs: "Third-party scripts: facades and consent",
    banner: {
      heading: "Consent for this demo",
      body: "The embed below is in the functional category. Your answer is kept in this browser only.",
      acceptLabel: "Accept",
      rejectLabel: "Reject",
      manageLabel: "Change consent",
    },
    frame: "Embed",
    facade:
      '<button type="button" class="fw-embed__load">Load the embed</button><p class="fw-embed__denied">Not granted yet: pressing loads nothing until you accept in the panel above.</p>',
  },
  images: {
    heading: "Responsive images",
    body: [
      "imageAttributes turns one source into a srcset, a sizes value and loading hints, through the site's own URL template. The browser picks the candidate.",
      "Each file below has its width drawn on it, so the picture shows which one your browser chose. Widen or narrow the window and reload to see it choose another.",
    ],
    docs: "Images",
    alt: "A drafting grid with the chosen candidate's width drawn on it in large type",
  },
  fonts: {
    heading: "Subset fonts",
    body: [
      "build.fonts hands each declared face to a subsetting adapter and writes its @font-face rule, with a metric-adjusted fallback so the swap does not move the text.",
      "This site's own type is system fonts, so this face is loaded for the specimen and nothing else. It is scoped to this page with pages, so this page links its stylesheet and preloads it, and the other pages here do neither.",
    ],
    docs: "Fonts",
    sample:
      "Fira Sans, cut down to printable ASCII: 0123456789 and every letter from A to z. A page that sets no text in this face never downloads it.",
  },
  social: {
    heading: "Social cards",
    body: [
      "build.socialImages draws a card for a page at build time, and the page's <head> names it as og:image, with the width and height the renderer measured. This page has one; the other pages of this site do not.",
      "The build draws cards before it renders pages, so a component can show its own page's card. The image below is this page's card, read with useSocialCard: the same file the og:image tag names.",
    ],
    docs: "Page head: cards the build draws",
    missing:
      "No card here: pagedeck dev draws no cards. Run pagedeck build to see this page's card.",
  },
  i18n: {
    heading: "Locales",
    body: [
      "This site publishes one locale. The dogfood site publishes English and German from one build, and each version of a page carries a canonical link and hreflang links to the other.",
    ],
    docs: "Canonicals and hreflang",
    links: [
      { href: `${DOGFOOD_ORIGIN}/en`, locale: "en", label: "The dogfood site in English" },
      { href: `${DOGFOOD_ORIGIN}/de`, locale: "de", label: "Die Dogfood-Site auf Deutsch" },
    ],
  },
} as const;

// This site's own files: a static host cannot resize, so the three widths are
// checked-in WebP files, which is why `format` is `webp`.
const IMAGES: ImagesSetting = defineImages({
  adapter: urlTemplate("/images{src}-{width}.{format}"),
  widths: [320, 640, 1280],
  quality: 80,
  format: "webp",
  sizes: "(min-width: 60rem) 36rem, calc(100vw - 2rem)",
});

const DEMO_IMAGE = { src: "/features/stack", width: 1280, height: 720 };

export const FONTS: FontsSetting = {
  adapter: defineFontSubset(),
  faces: [
    {
      family: "Fira Sans",
      src: FIRA_SANS,
      weight: 400,
      style: "normal",
      display: "swap",
      unicodeRanges: ["U+0020-007E"],
      fallback: ["Helvetica", "Arial", "sans-serif"],
      aboveFold: true,
      pages: [FEATURES_PATH],
    },
  ],
};

const CARD_EYEBROW = "Pagedeck";

const CARD_ALT = `This page's social card: the word ${CARD_EYEBROW} above the headline "${COPY.title}"`;

export const SOCIAL_IMAGES: SocialImagesSetting = {
  adapter: defineSocialImage({
    fonts: [{ family: "Fira Sans", src: FIRA_SANS, weight: 400 }],
  }),
  inputs: (page) =>
    page.path === FEATURES_PATH ? { eyebrow: CARD_EYEBROW } : undefined,
};

// No `build.prePaint`: a facade's trigger is a press, after hydration, and the
// snippet would put inline script on every page, `/` included.
export const SCRIPTS: ScriptsSetting = defineScripts({
  scripts: [
    {
      name: "embed",
      src: "/embed/demo-embed.js",
      strategy: "facade",
      facade: { html: COPY.consent.facade, mount: EMBED_MOUNT },
      category: "functional",
    },
  ],
  pageTypes: { "/**": { embed: "off" } },
  pages: { [`en:${FEATURES_PATH}`]: { embed: "facade" } },
});

export function featuresPageSource(): PageSource<Record<string, never>> {
  return {
    instances: (_store: ContentStoreReader) => [
      { locale: "en", params: {}, dependencies: [] },
    ],
    route: () => FEATURES_ROUTE,
  };
}

export const FEATURES_HEAD: PageHead = {
  title: COPY.title,
  description: COPY.description,
};

function docs(path: string, label: string) {
  return { href: `${DOCS_ORIGIN}/${path}`, label };
}

function section(
  id: string,
  copy: { readonly heading: string; readonly body: readonly string[] },
  link: ReturnType<typeof docs>,
  children: EntryNode[],
): EntryNode {
  return {
    component: FEATURE_SECTION,
    props: {
      id,
      heading: copy.heading,
      body: copy.body,
      docs: link,
    },
    children,
  };
}

// The islands section comes first so `island_load` sits above the fold
// threshold; below it, fold tuning would demote its declared `load` (#24).
export function featuresContent(page: Page): PageContent {
  const probe = (name: string, waiting: string = COPY.islands.waiting) => ({
    copy: { name, waiting, hydrated: COPY.islands.hydrated },
  });
  const image = imageAttributes({ images: IMAGES, image: DEMO_IMAGE, page });
  const candidates = image.srcSet
    .split(", ")
    .map((entry) => entry.split(" ") as [string, string]);
  const formats = [
    ...new Set(candidates.map(([url]) => url.slice(url.lastIndexOf(".") + 1))),
  ];
  return {
    tree: [
      {
        component: FEATURES_PAGE,
        props: { title: COPY.title, intro: COPY.intro },
        children: [
          section(
            "islands",
            COPY.islands,
            docs("reference/fold-strategy", COPY.islands.docs),
            [
              { component: ISLAND_LOAD, props: probe("load") },
              { component: ISLAND_IDLE, props: probe("idle") },
              { component: ISLAND_VISIBLE, props: probe("visible") },
              {
                component: STATIC_PROBE,
                props: probe("static", COPY.islands.staticWaiting),
              },
            ],
          ),
          section(
            "search",
            COPY.search,
            docs("reference/site-search", COPY.search.docs),
            [
              {
                component: SEARCH,
                props: {
                  locale: "en",
                  label: COPY.search.label,
                  emptyLabel: COPY.search.emptyLabel,
                },
              },
            ],
          ),
          section(
            "consent",
            COPY.consent,
            docs("reference/third-party-scripts#facades", COPY.consent.docs),
            [
              { component: CONSENT_BANNER, props: { ...COPY.consent.banner } },
              {
                component: EMBED_FRAME,
                props: { mount: EMBED_MOUNT, label: COPY.consent.frame },
              },
            ],
          ),
          section("images", COPY.images, docs("reference/images", COPY.images.docs), [
            {
              component: RESPONSIVE_IMAGE,
              props: {
                image,
                alt: COPY.images.alt,
                facts: [
                  { label: "srcset", value: candidates.map(([url]) => url).join(", ") },
                  { label: "widths", value: candidates.map(([, width]) => width).join(", ") },
                  { label: "formats", value: formats.join(", ") },
                  { label: "sizes", value: image.sizes },
                  { label: "loading", value: image.loading },
                ],
              },
            },
          ]),
          section("fonts", COPY.fonts, docs("reference/fonts", COPY.fonts.docs), [
            {
              component: FONT_SPECIMEN,
              props: {
                sample: COPY.fonts.sample,
                facts: [
                  { label: "face", value: "Fira Sans 400" },
                  { label: "unicode-range", value: "U+0020-007E" },
                  { label: "fallback", value: "Helvetica, Arial, size-adjusted" },
                ],
              },
            },
          ]),
          section(
            "social-cards",
            COPY.social,
            docs("reference/page-head#cards-the-build-draws", COPY.social.docs),
            [
              {
                component: SOCIAL_CARD,
                props: { alt: CARD_ALT, missing: COPY.social.missing },
              },
            ],
          ),
          section(
            "i18n",
            COPY.i18n,
            docs("reference/canonicals-and-hreflang", COPY.i18n.docs),
            [{ component: LOCALE_LINKS, props: { links: COPY.i18n.links } }],
          ),
        ],
      },
    ],
  };
}
