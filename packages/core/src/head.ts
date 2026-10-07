import type { PageLinks } from "./alternates.js";
import type { AbsorbedMetadata, HeadClaim } from "./render.js";
import { redactTarget } from "./snapshot.js";
import { VIEW_TRANSITION_STYLE } from "./view-transitions.js";

export type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonLdValue[]
  | JsonLdNode;

export interface JsonLdNode {
  readonly [term: string]: JsonLdValue;
}

export interface PageHead {
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  readonly jsonLd?: JsonLdNode | readonly JsonLdNode[];
}

/** `&` first: escaping `"` first would escape the `&` of `&quot;` again. */
export function escapeAttributeValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function jsonLdText(nodes: JsonLdNode | readonly JsonLdNode[]): string {
  return scriptDataText(JSON.stringify(nodes));
}

/**
 * Only `<` is escaped: it is the sole way out of script data, so neither
 * `</script` nor `<!--` can appear.
 */
function scriptDataText(json: string): string {
  return json.replaceAll("<", "\\u003c");
}

export function headElements(input: {
  head: PageHead | undefined;
  socialImage?: SocialImageDimensions;
  styles: readonly string[];
  inlineStyles: readonly string[];
  links: PageLinks | undefined;
  noindex?: boolean;
  feed?: { readonly href: string; readonly title: string };
  fontPreloads?: readonly string[];
  prePaint?: readonly string[];
  absorbed: readonly AbsorbedMetadata[];
  supplement?: string;
  viewTransition?: boolean;
  speculation?: string;
}): readonly string[] {
  const {
    head,
    socialImage,
    styles,
    inlineStyles,
    links,
    noindex,
    feed,
    fontPreloads,
    prePaint,
    absorbed,
    supplement,
    viewTransition,
    speculation,
  } = input;
  const children: string[] = ['<meta charset="utf-8">'];

  if (head?.title !== undefined) {
    children.push(`<title>${escapeText(head.title)}</title>`);
  }
  if (head?.description !== undefined) {
    children.push(meta("name", "description", head.description));
  }
  if (head?.title !== undefined) {
    children.push(meta("property", "og:title", head.title));
  }
  if (head?.description !== undefined) {
    children.push(meta("property", "og:description", head.description));
  }
  if (head?.image !== undefined) {
    children.push(meta("property", "og:image", head.image));
  }
  if (socialImage !== undefined) {
    children.push(
      meta("property", "og:image:width", String(socialImage.width)),
      meta("property", "og:image:height", String(socialImage.height)),
      meta("name", "twitter:card", twitterCard(socialImage)),
    );
  }

  // Not escaped again: React's serializer already escaped these bytes.
  const claimed = new Set(declaredClaims(head, socialImage).keys());
  for (const one of absorbed) {
    if (one.claim !== undefined) {
      if (claimed.has(one.claim.singleton)) continue;
      claimed.add(one.claim.singleton);
    }
    children.push(one.tag);
  }

  if (noindex === true) {
    children.push(meta("name", "robots", "noindex"));
  }
  if (links !== undefined) {
    children.push(
      `<link rel="canonical" href="${escapeAttributeValue(links.canonical)}">`,
    );
    for (const { hreflang, href } of links.alternates) {
      children.push(
        `<link rel="alternate" hreflang="${escapeAttributeValue(hreflang)}" href="${escapeAttributeValue(href)}">`,
      );
    }
  }

  if (feed !== undefined) {
    children.push(
      `<link rel="alternate" type="application/rss+xml" title="${escapeAttributeValue(feed.title)}" href="${escapeAttributeValue(feed.href)}">`,
    );
  }

  if (fontPreloads !== undefined) children.push(...fontPreloads);

  // The site's own text, deliberately unescaped: `pre-paint.ts` refuses what it
  // cannot hold.
  if (prePaint !== undefined) {
    for (const source of prePaint) children.push(`<script>${source}</script>`);
  }

  if (viewTransition === true) children.push(VIEW_TRANSITION_STYLE);
  for (const href of styles) {
    children.push(`<link rel="stylesheet" href="${escapeAttributeValue(href)}">`);
  }
  children.push(...inlineStyles);
  if (supplement !== undefined) children.push(supplement);

  const jsonLd = head?.jsonLd;
  if (jsonLd !== undefined && carriesTerm(jsonLd)) {
    children.push(
      `<script type="application/ld+json">${jsonLdText(jsonLd)}</script>`,
    );
  }

  if (speculation !== undefined) {
    children.push(
      `<script type="speculationrules">${scriptDataText(speculation)}</script>`,
    );
  }
  return children;
}

export interface SocialImageDimensions {
  readonly width: number;
  readonly height: number;
}

const LARGE_CARD_MINIMUM = { width: 300, height: 157 } as const;

function twitterCard(dimensions: SocialImageDimensions): string {
  return dimensions.width >= LARGE_CARD_MINIMUM.width &&
    dimensions.height >= LARGE_CARD_MINIMUM.height
    ? "summary_large_image"
    : "summary";
}

const DECLARED = "build.head";

const FRAMEWORK = "the build's own <head>";

function declaredClaims(
  head: PageHead | undefined,
  socialImage: SocialImageDimensions | undefined,
): Map<string, { by: string; value: string }> {
  const claims = new Map<string, { by: string; value: string }>([
    ["<meta charset>", { by: FRAMEWORK, value: "utf-8" }],
  ]);
  if (head?.title !== undefined) {
    claims.set("<title>", { by: DECLARED, value: head.title });
    claims.set('<meta property="og:title">', {
      by: DECLARED,
      value: head.title,
    });
  }
  if (head?.description !== undefined) {
    claims.set('<meta name="description">', {
      by: DECLARED,
      value: head.description,
    });
    claims.set('<meta property="og:description">', {
      by: DECLARED,
      value: head.description,
    });
  }
  if (head?.image !== undefined) {
    claims.set('<meta property="og:image">', {
      by: DECLARED,
      value: head.image,
    });
  }
  if (socialImage !== undefined) {
    claims.set('<meta property="og:image:width">', {
      by: FRAMEWORK,
      value: String(socialImage.width),
    });
    claims.set('<meta property="og:image:height">', {
      by: FRAMEWORK,
      value: String(socialImage.height),
    });
    claims.set('<meta name="twitter:card">', {
      by: FRAMEWORK,
      value: twitterCard(socialImage),
    });
  }
  return claims;
}

const UNATTRIBUTED = "the entry's own tree";

export function absorbedHeadConflicts(input: {
  entry: string;
  head: PageHead | undefined;
  socialImage?: SocialImageDimensions;
  absorbed: readonly AbsorbedMetadata[];
}): string | undefined {
  const claims = new Map<string, { by: string; value: string }[]>();
  for (const [singleton, claim] of declaredClaims(
    input.head,
    input.socialImage,
  )) {
    claims.set(singleton, [claim]);
  }
  for (const one of input.absorbed) {
    if (one.claim === undefined) continue;
    const by = one.component === undefined ? UNATTRIBUTED : `"${one.component}"`;
    const made = claims.get(one.claim.singleton) ?? [];
    made.push({ by, value: one.claim.value });
    claims.set(one.claim.singleton, made);
  }

  const paragraphs = [...claims]
    .filter(([, made]) => new Set(made.map((one) => one.value)).size > 1)
    .map(([singleton, made]) => conflictParagraph(input.entry, singleton, made));
  return paragraphs.length === 0 ? undefined : paragraphs.join("\n\n");
}

export function quotedValue(value: string): string {
  if (URL.canParse(value)) return redactTarget(value);
  if (!/^[./]/.test(value)) return value;
  const cut = /[?#]/.exec(value);
  return cut === null ? value : `${value.slice(0, cut.index + 1)}…`;
}

function conflictParagraph(
  entry: string,
  singleton: string,
  made: readonly { by: string; value: string }[],
): string {
  const lines = made
    .map((one) => `  ${one.by} — "${quotedValue(one.value)}"`)
    .join("\n");
  return `Entry ${entry}: ${String(made.length)} claims on ${singleton} disagree — a document holds one ${singleton}, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:\n${lines}`;
}

function carriesTerm(jsonLd: JsonLdNode | readonly JsonLdNode[]): boolean {
  const nodes: readonly JsonLdNode[] = Array.isArray(jsonLd)
    ? (jsonLd as readonly JsonLdNode[])
    : [jsonLd as JsonLdNode];
  return nodes.some((node) => Object.keys(node).length > 0);
}

function meta(key: "name" | "property", term: string, value: string): string {
  return `<meta ${key}="${term}" content="${escapeAttributeValue(value)}">`;
}
