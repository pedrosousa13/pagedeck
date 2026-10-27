import { readdirSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE = join(import.meta.dirname, "..");

export const REPOSITORY = join(PACKAGE, "..", "..", "docs");

// The entries directly under the repository's `docs/`: `published` ones are packed, through
// `nav.json` and `prepack`; `excluded` ones stay in the repository.
export const REPOSITORY_DOCS = {
  published: ["adr", "deploy-recipe.md", "error-messages.md"],
  excluded: [
    "agents",
    "dogfood-*.md",
    "research",
    "scaling-verification.md",
    "specs",
    "success-criteria.md",
  ],
} as const;

export function listed(name: string, list: readonly string[]): boolean {
  return list.some((pattern) => {
    const [head, tail] = pattern.split("*");
    return tail === undefined
      ? name === pattern
      : name.length >= (head as string).length + tail.length &&
          name.startsWith(head as string) &&
          name.endsWith(tail);
  });
}

// Not `readdirSync`'s `recursive`, which follows the package's `node_modules` links.
function walk(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((dirent) => {
    const file = `${prefix}${dirent.name}`;
    if (dirent.isDirectory()) return walk(root, `${file}/`);
    return dirent.isFile() && file.endsWith(".md") ? [file] : [];
  });
}

const top = (file: string): string => file.split("/")[0] ?? file;

const isPublished = (file: string): boolean => listed(top(file), REPOSITORY_DOCS.published);

// The package's own pages: not its readme, its dependencies or the copies of `docs/` its
// prepack writes, which are read at source.
export const guides = (): string[] =>
  walk(PACKAGE)
    .filter((file) => file !== "README.md" && top(file) !== "node_modules" && !isPublished(file))
    .sort();

export const published = (): string[] => walk(REPOSITORY).filter(isPublished).sort();

// Where a page `nav.json` lists is read from: the package, or `docs/` for a published copy.
export const sourceOf = (page: string): string => join(isPublished(page) ? REPOSITORY : PACKAGE, page);
