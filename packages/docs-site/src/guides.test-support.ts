import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isGuide } from "./site.js";

export const GUIDES = join(import.meta.dirname, "..", "..", "docs");

// Not `readdirSync`'s `recursive`, which follows the package's `node_modules` links.
function walk(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((dirent) => {
    const file = `${prefix}${dirent.name}`;
    if (dirent.isDirectory()) return walk(root, `${file}/`);
    return dirent.isFile() && file.endsWith(".md") ? [file] : [];
  });
}

export function guideFiles(): string[] {
  return walk(GUIDES).filter(isGuide).sort();
}

export function markdownFiles(root: string): string[] {
  return walk(root).sort();
}
