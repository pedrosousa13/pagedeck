import type { MarkdownEntry } from "@pagedeck/markdown-loader";
import type { Entry } from "@pagedeck/content";

export interface Section {
  readonly name: string;
  readonly label: string;
}

// Editorial order, not sorted: alphabetical would open on "Explanation".
export const SECTIONS = [
  { name: "about", label: "Overview" },
  { name: "tutorial", label: "Tutorials" },
  { name: "how-to", label: "How-to guides" },
  { name: "reference", label: "Reference" },
  { name: "explanation", label: "Explanation" },
] as const satisfies readonly Section[];

// A union only because `SECTIONS` is `as const`; typed as `Section[]`, every name
// would be a `string` and the schema would have nothing to narrow to.
export type SectionName = (typeof SECTIONS)[number]["name"];

const SECTION_NAMES: readonly string[] = SECTIONS.map(({ name }) => name);

export const SECTION_OF_DIRECTORY: Readonly<Record<string, string>> = {
  "": "reference",
  adr: "explanation",
};

function directoryOf(file: string): string {
  const slash = file.indexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
}

export function sectionOf(entry: MarkdownEntry): string | undefined {
  const declared = entry.frontmatter["section"];
  if (typeof declared === "string" && SECTION_NAMES.includes(declared)) {
    return declared;
  }
  return SECTION_OF_DIRECTORY[directoryOf(entry.file)];
}

// A plain `Error`, not a `ConfigError`: the config is intact, and what trips
// this is a new document.
export function refuseUnplaced(unplaced: readonly string[]): void {
  if (unplaced.length === 0) return;
  const subject =
    unplaced.length === 1
      ? "1 document is in no section"
      : `${String(unplaced.length)} documents are in no section`;
  throw new Error(
    `Docs site: ${subject}, so the navigation would not list ${unplaced.length === 1 ? "it" : "them"} — declare "section" in the document's frontmatter as one of ${SECTION_NAMES.join(", ")}, or add its directory to SECTION_OF_DIRECTORY:\n${unplaced
      .map((file) => `  ${file}`)
      .join("\n")}`,
  );
}

export interface NavLink {
  href: string;
  label: string;
  current: boolean;
}

export interface NavSection {
  label: string;
  links: readonly NavLink[];
}

export interface NavDocument {
  readonly href: string;
  readonly entry: Entry<MarkdownEntry>;
}

export function buildNav(
  documents: readonly NavDocument[],
  currentHref: string,
): NavSection[] {
  const nav: NavSection[] = [];
  for (const section of SECTIONS) {
    const links = documents
      .filter((document) => sectionOf(document.entry.data) === section.name)
      .map(({ href, entry }) => ({
        href,
        label: entry.data.title,
        current: href === currentHref,
      }))
      .sort((left, right) => (left.href < right.href ? -1 : 1));
    if (links.length > 0) nav.push({ label: section.label, links });
  }
  return nav;
}

export function neighbours(nav: readonly NavSection[]): {
  previous: NavLink | undefined;
  next: NavLink | undefined;
} {
  const links = nav.flatMap((section) => section.links);
  const at = links.findIndex((link) => link.current);
  if (at === -1) return { previous: undefined, next: undefined };
  return { previous: links[at - 1], next: links[at + 1] };
}
