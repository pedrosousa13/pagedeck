import type {
  ComponentUsage,
  Entry,
  EntryId,
  Loader,
  SyncResult,
} from "@pagedeck/content";
import type { Block, PageData, PageEntry } from "./content.js";

export function defineEntriesLoader(
  entries: readonly PageEntry[],
): Loader<PageData> {
  const writeAll: Loader<PageData>["syncAll"] = (writer): SyncResult => {
    const changed: EntryId[] = [];
    for (const entry of entries) {
      writer.upsert(entry);
      changed.push({ locale: entry.locale, path: entry.path });
    }
    return { changed, deleted: [], cursor: 0 };
  };
  return {
    syncAll: (writer) => ({ ...writeAll(writer), authoritative: true }),
    syncSince: (writer) => writeAll(writer),
  };
}

export function blockUsage(entry: Entry<PageData>): ComponentUsage[] {
  if (entry.data.mode === "template") return [];
  const usage = new Map<string, ComponentUsage>();
  let position = 0;

  function visit(block: Block, depth: number): void {
    const seen = usage.get(block.component);
    if (seen === undefined) {
      usage.set(block.component, {
        component: block.component,
        count: 1,
        foldScore: position,
        depth,
        isRoot: depth === 0,
      });
    } else {
      seen.count += 1;
      seen.depth = Math.min(seen.depth, depth);
      seen.isRoot = seen.isRoot || depth === 0;
    }
    position += 1;
    for (const child of block.children) visit(child, depth + 1);
  }

  for (const block of entry.data.tree) visit(block, 0);
  return [...usage.values()];
}

export function componentNames(data: PageData): readonly string[] {
  if (data.mode === "template") return [data.template];
  const names = new Set<string>();
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      names.add(block.component);
      walk(block.children);
    }
  };
  walk(data.tree);
  return [...names].sort();
}
