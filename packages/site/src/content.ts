import type { EntryId } from "@pagedeck/content";

/** One node of a stored entry's tree. */
export interface Block {
  readonly component: string;
  readonly id: string;
  readonly props: Readonly<Record<string, Field>>;
  readonly children: readonly Block[];
}

// `mode`, `title`, `template` and `fields` reach a template's island props by name.
export type PageData =
  | { readonly mode: "tree"; readonly title: string; readonly tree: readonly Block[] }
  | {
      readonly mode: "template";
      readonly title: string;
      readonly template: string;
      readonly fields: Readonly<Record<string, Field>>;
    };

export interface PageEntry extends EntryId {
  readonly data: PageData;
}

export interface ImageField {
  readonly kind: "image";
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

/** `to: null` is a link field nobody filled in. */
export interface LinkField {
  readonly kind: "link";
  readonly to: EntryId | null;
}

/** A value passed to the component as stored. */
export type PlainField = string | readonly Readonly<Record<string, string>>[];

export type Field = ImageField | LinkField | PlainField;

const HERO_IMAGE = {
  kind: "image",
  src: "/uploads/hero.jpg",
  width: 2400,
  height: 1350,
} as const;

function home(headline: string): PageEntry {
  return {
    locale: "en",
    path: "home",
    data: {
      mode: "tree",
      title: "Home",
      tree: [
        {
          component: "hero",
          id: "home-hero",
          props: {
            headline,
            image: {
              ...HERO_IMAGE,
              alt: "A build finishing in a terminal",
            } satisfies ImageField,
          },
          children: [
            {
              component: "button",
              id: "home-button",
              props: {
                label: "See pricing",
                link: {
                  kind: "link",
                  to: { locale: "en", path: "pricing" },
                } satisfies LinkField,
              },
              children: [],
            },
          ],
        },
        {
          component: "feature_grid",
          id: "home-grid",
          props: {},
          children: [
            { component: "feature_card", id: "home-card-1", props: { title: "Fast" }, children: [] },
            { component: "feature_card", id: "home-card-2", props: { title: "Small" }, children: [] },
          ],
        },
      ],
    },
  };
}

const PUBLISHED_REST: readonly PageEntry[] = [
  {
    locale: "de",
    path: "home",
    data: {
      mode: "tree",
      title: "Startseite",
      tree: [
        {
          component: "hero",
          id: "home-hero",
          props: {
            headline: "Bau die Seite",
            image: {
              ...HERO_IMAGE,
              alt: "Ein Build, der im Terminal fertig wird",
            } satisfies ImageField,
          },
          children: [],
        },
      ],
    },
  },
  {
    locale: "en",
    path: "pricing",
    data: {
      mode: "template",
      title: "Pricing",
      template: "pricing_page",
      fields: {
        headline: "Plans",
        plans: [
          { name: "Starter", price: "0" },
          { name: "Team", price: "49" },
        ] satisfies PlainField,
      },
    },
  },
  {
    locale: "en",
    path: "legal/terms",
    data: {
      mode: "template",
      title: "Terms",
      template: "legal_page",
      fields: {
        body_text: "The terms.",
        related: {
          kind: "link",
          to: { locale: "en", path: "pricing" },
        } satisfies LinkField,
        unset_link: { kind: "link", to: null } satisfies LinkField,
      },
    },
  },
];

export const PUBLISHED_ENTRIES: readonly PageEntry[] = [
  home("Ship the site"),
  ...PUBLISHED_REST,
];

export const DRAFT_ENTRIES: readonly PageEntry[] = [
  home("Ship the site, faster"),
  ...PUBLISHED_REST,
  {
    locale: "en",
    path: "careers",
    data: {
      mode: "template",
      title: "Careers",
      template: "landing_page",
      fields: {
        headline: "Join us",
        email_label: "Email address",
        apply_label: "Apply",
        send_label: "Send",
      },
    },
  },
];
