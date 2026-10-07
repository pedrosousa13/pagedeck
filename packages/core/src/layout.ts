import type { ContentStoreReader } from "@pagedeck/content";
import { getComponent } from "@pagedeck/islands";
import type { ComponentRegistry } from "@pagedeck/islands";
import { ConfigError, printable } from "./exit.js";
import type { Page } from "./pages.js";
import { quoteIdentifier } from "./quote.js";
import { RenderError } from "./tree.js";
import type { PageContent } from "./tree.js";

type ContentCallback = (
  page: Page,
  store: ContentStoreReader,
) => PageContent | Promise<PageContent>;

interface EntryFault {
  readonly entry: string;
  readonly detail: string;
}

interface CollectionFaults {
  readonly shape: EntryFault[];
  readonly unregistered: EntryFault[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNameList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((name) => typeof name === "string")
  );
}

function shapeReport(
  collection: string,
  faults: readonly EntryFault[],
): string {
  const headline =
    faults.length === 1
      ? "1 entry does not have"
      : `${String(faults.length)} entries do not have`;
  return `Collection "${collection}": ${headline} the shape a layout renders — give each a string title and html, and a list at frontmatter.components if it has one, as the markdown loader writes them, or render the collection through a content callback instead:\n${faultLines(faults)}`;
}

function unregisteredReport(
  collection: string,
  faults: readonly EntryFault[],
  registry: ComponentRegistry,
): string {
  const headline =
    faults.length === 1
      ? "1 entry names components"
      : `${String(faults.length)} entries name components`;
  const registered = Object.keys(registry)
    .sort()
    .map((name) => quoteIdentifier(name))
    .join(", ");
  return `Collection "${collection}": ${headline} at frontmatter.components that build.components does not register — name only registered components, which are ${registered}:\n${faultLines(faults)}`;
}

function faultLines(faults: readonly EntryFault[]): string {
  return faults.map(({ entry, detail }) => `  ${printable(entry)} — ${detail}`).join("\n");
}

/**
 * Entry content picks only from the registry: a name is looked up and never
 * resolved, so a CMS-written value can never reach an import.
 */
export function layoutContents(
  pages: readonly Page[],
  store: ContentStoreReader,
  registry: ComponentRegistry,
): ReadonlyMap<Page, PageContent> {
  const contents = new Map<Page, PageContent>();
  const faults = new Map<string, CollectionFaults>();
  const seen = new Set<string>();
  for (const page of pages) {
    const { layout, collection, entry } = page;
    if (
      layout === undefined ||
      collection === undefined ||
      entry === undefined
    ) {
      continue;
    }
    const data = store.getEntry(collection, entry.locale, entry.path)?.data;
    const record = isRecord(data) ? data : {};
    const { title, html, frontmatter } = record;
    const declared = isRecord(frontmatter)
      ? (frontmatter["components"] ?? [])
      : [];
    const names = isNameList(declared) ? declared : undefined;
    const shape = [
      ...(typeof title === "string" ? [] : ["title is not a string"]),
      ...(typeof html === "string" ? [] : ["html is not a string"]),
      ...(names === undefined
        ? ["frontmatter.components is not a list"]
        : []),
    ];
    const unregistered = (names ?? []).filter(
      (name) => getComponent(registry, name) === undefined,
    );
    if (shape.length === 0 && unregistered.length === 0) {
      contents.set(page, {
        tree: [
          {
            component: layout,
            props: { title, html },
            children: (names ?? []).map((name) => ({
              component: name,
            })),
          },
        ],
      });
      continue;
    }
    const id = `/${entry.locale}/${entry.path}`;
    const key = `${collection} ${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const held = faults.get(collection) ?? { shape: [], unregistered: [] };
    faults.set(collection, held);
    if (shape.length > 0) {
      held.shape.push({ entry: id, detail: shape.join(", ") });
    }
    if (unregistered.length > 0) {
      held.unregistered.push({
        entry: id,
        detail: unregistered.map((name) => quoteIdentifier(name)).join(", "),
      });
    }
  }
  const reports = [...faults].flatMap(([collection, held]) => [
    ...(held.shape.length === 0 ? [] : [shapeReport(collection, held.shape)]),
    ...(held.unregistered.length === 0
      ? []
      : [unregisteredReport(collection, held.unregistered, registry)]),
  ]);
  if (reports.length > 0) throw new RenderError(reports.join("\n\n"));
  return contents;
}

export function contentOf(
  page: Page,
  layouts: ReadonlyMap<Page, PageContent>,
  store: ContentStoreReader,
  content: ContentCallback | undefined,
): PageContent | Promise<PageContent> {
  const laid = layouts.get(page);
  if (laid !== undefined) return laid;
  if (content === undefined) {
    throw new ConfigError(
      `Page /${page.locale}${page.path}: names no layout, and the build section declares no content callback to render it — declare build.content, or name a layout on the page's source`,
    );
  }
  return content(page, store);
}
