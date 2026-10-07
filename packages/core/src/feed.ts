import type { ContentStoreReader } from "@pagedeck/content";
import { variantUrl } from "./alternates.js";
import { ConfigError } from "./exit.js";
import { domainHost, localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { collisionLine, fileKey } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";
import { quote, quoteAddress } from "./quote.js";
import { escapeXml, XML_DECLARATION } from "./xml.js";

export interface FeedItemFields {
  readonly title: string;
  readonly description?: string;
  readonly pubDate?: string;
}

export interface FeedSetting {
  readonly collection: string;
  readonly title: string;
  readonly description: string;
  readonly item: FeedItemFields;
}

const SHAPE_FIX =
  'feed: { collection: "posts", title: "My Site", description: "Recent posts", item: { title: "title" } }';

export function feedFaultReport(
  value: unknown,
  origin: unknown,
  locales: unknown,
  where: string,
): string | undefined {
  const faults =
    typeof value !== "object" || value === null || Array.isArray(value)
      ? undefined
      : settingFaults(value as Record<string, unknown>);
  const sections: string[] = [];
  if (faults === undefined) {
    sections.push(
      `${where}: "build.feed" must be an object naming the collection its items come from — ${SHAPE_FIX}`,
    );
  } else if (faults.length > 0) {
    sections.push(
      `${where}: "build.feed" declares ${String(faults.length)} ${
        faults.length === 1 ? "field" : "fields"
      } this build cannot write a feed from — declare each as the type its own line names:\n${faults.join("\n")}`,
    );
  }
  if (origin === undefined) {
    sections.push(
      `${where}: "build.feed" is declared without "build.origin", and every <link> a feed item carries is an absolute URL — declare origin: "https://example.com", or remove feed`,
    );
  }
  if (typeof origin === "string") {
    const unserved = unservedOrigin(origin, locales);
    if (unserved !== undefined) {
      sections.push(
        `${where}: "build.feed" is declared on a site with no output tree to write it in — every locale is served from a domain of its own, none of them is the origin's host, and the feed is one file at the origin's own address — declare a locale with no domain, or point origin at one of the declared domains:\n  ${quoteAddress(origin)} — the declared domains are ${unserved
          .map((domain) => quoteAddress(domain))
          .join(", ")}`,
      );
    }
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function unservedOrigin(
  origin: string,
  locales: unknown,
): readonly string[] | undefined {
  if (!(locales instanceof Map)) return undefined;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return undefined;
  }
  const domains: string[] = [];
  for (const locale of locales.values() as Iterable<unknown>) {
    const domain = (locale as { domain?: unknown } | null)?.domain;
    if (typeof domain !== "string") return undefined;
    if (domainHost(domain) === host) return undefined;
    domains.push(domain);
  }
  return domains.length === 0 ? undefined : domains;
}

function settingFaults(record: Record<string, unknown>): string[] {
  const faults: string[] = [];
  const named = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;

  const collection = named("collection");
  if (typeof collection !== "string" || collection === "") {
    faults.push(
      `  "collection" — ${quote(collection)} — not the name of a collection to draw items from — name the one whose entries are the feed's items — collection: "posts"`,
    );
  }
  const title = named("title");
  if (typeof title !== "string" || title === "") {
    faults.push(
      `  "title" — ${quote(title)} — not a channel title — write the name a reader's feed list should show — title: "My Site"`,
    );
  }
  const description = named("description");
  if (typeof description !== "string" || description === "") {
    faults.push(
      `  "description" — ${quote(description)} — not a channel description — write the sentence that says what the feed carries — description: "Recent posts"`,
    );
  }
  const item = named("item");
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    faults.push(
      `  "item" — ${quote(item)} — not an entry-to-item mapping — name the entry fields an item is built from — item: { title: "title" }`,
    );
    return faults;
  }
  const fields = item as Record<string, unknown>;
  const field = (key: string): unknown =>
    Object.hasOwn(fields, key) ? fields[key] : undefined;
  const itemTitle = field("title");
  if (typeof itemTitle !== "string" || itemTitle === "") {
    faults.push(
      `  "item.title" — ${quote(itemTitle)} — not an entry field name — name the field an entry's title is stored in — item: { title: "title" }`,
    );
  }
  for (const key of ["description", "pubDate"] as const) {
    const declared = field(key);
    if (
      declared !== undefined &&
      (typeof declared !== "string" || declared === "")
    ) {
      faults.push(
        `  "item.${key}" — ${quote(declared)} — not an entry field name — name the field it is stored in, or omit it — item: { ${key}: "${key === "pubDate" ? "date" : "summary"}" }`,
      );
    }
  }
  return faults;
}

const FEED_PATH = "/rss.xml";

export function feedUrl(origin: string): string {
  return variantUrl(origin, { output: FEED_PATH });
}

export interface FeedInput {
  setting: FeedSetting;
  origin: string;
  store: ContentStoreReader;
  pages: readonly Page[];
  locales: LocaleSet;
  emitted: readonly EmittedFile[];
}

export function feedFiles(input: FeedInput): readonly EmittedFile[] {
  const { setting, origin, store, pages } = input;
  const domain = originTree(origin, input.locales);

  const items = pages.flatMap((page) => {
    if (page.collection !== setting.collection) return [];
    if (page.entry === undefined || page.fallbackFrom !== undefined) return [];
    const entry = store.getEntry(
      page.collection,
      page.entry.locale,
      page.entry.path,
    );
    if (entry === undefined) return [];
    const data = entry.data;
    const field = (name: string | undefined): string | undefined => {
      if (name === undefined) return undefined;
      if (typeof data !== "object" || data === null) return undefined;
      const held = (data as Record<string, unknown>)[name];
      return typeof held === "string" && held !== "" ? held : undefined;
    };
    return [
      {
        link: variantUrl(origin, page),
        title: field(setting.item.title),
        description: field(setting.item.description),
        date: instant(field(setting.item.pubDate)),
      },
    ];
  });
  items.sort((a, b) => {
    const at = a.date?.getTime();
    const bt = b.date?.getTime();
    if (at !== bt) {
      if (at === undefined) return 1;
      if (bt === undefined) return -1;
      return bt - at;
    }
    return a.link < b.link ? -1 : a.link > b.link ? 1 : 0;
  });

  const key = fileKey(domain, FEED_PATH);
  const clash = input.emitted.find(
    (file) => fileKey(file.domain, file.path) === key,
  );
  if (clash !== undefined) {
    throw new ConfigError(
      `Feed: the feed is at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the feed is:\n${collisionLine(key, clash.kind)} — move the page off that address`,
    );
  }
  return [
    {
      ...(domain === undefined ? {} : { domain }),
      path: FEED_PATH,
      kind: "asset",
      contents: channelXml({ setting, origin, items }),
    },
  ];
}

function originTree(origin: string, locales: LocaleSet): string | undefined {
  const host = new URL(origin).hostname;
  for (const locale of locales.values()) {
    if (locale.domain === undefined) continue;
    if (domainHost(locale.domain) === host) return localeTree(locale);
  }
  return undefined;
}

interface FeedItem {
  readonly link: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly date: Date | undefined;
}

const ATOM_NS = "http://www.w3.org/2005/Atom";

function channelXml(input: {
  setting: FeedSetting;
  origin: string;
  items: readonly FeedItem[];
}): string {
  const lines = input.items.flatMap((item) => [
    "<item>",
    ...(item.title === undefined
      ? []
      : [`<title>${escapeXml(item.title)}</title>`]),
    `<link>${escapeXml(item.link)}</link>`,
    `<guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
    ...(item.date === undefined
      ? []
      : [`<pubDate>${escapeXml(item.date.toUTCString())}</pubDate>`]),
    ...(item.description === undefined
      ? []
      : [`<description>${escapeXml(item.description)}</description>`]),
    "</item>",
  ]);
  return `${XML_DECLARATION}
<rss version="2.0" xmlns:atom="${ATOM_NS}">
<channel>
<title>${escapeXml(input.setting.title)}</title>
<link>${escapeXml(input.origin)}</link>
<description>${escapeXml(input.setting.description)}</description>
<atom:link rel="self" type="application/rss+xml" href="${escapeXml(feedUrl(input.origin))}"/>
${lines.map((line) => `${line}\n`).join("")}</channel>
</rss>
`;
}

const ISO_8601 =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A stamp with no designator is UTC: `new Date(stamp)` would read it in the
 * build host's zone.
 */
function instant(stamp: string | undefined): Date | undefined {
  if (stamp === undefined) return undefined;
  const parts = ISO_8601.exec(stamp);
  if (parts === null) return undefined;
  const date = new Date(
    `${parts[1] ?? ""}T${parts[2] ?? "00:00:00"}${parts[3] ?? "Z"}`,
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}
