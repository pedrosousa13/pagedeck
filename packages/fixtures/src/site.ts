import { join } from "node:path";
import type { ComponentUsage } from "@pagedeck/content";

export interface ComponentNode {
  component: string;
  props?: Record<string, unknown>;
  children?: ComponentNode[];
}

export interface TreePage {
  mode: "tree";
  title: string;
  tree: ComponentNode[];
}

export interface TemplatePage {
  mode: "template";
  title: string;
  template: string;
  fields: Record<string, unknown>;
}

export type FixturePage = TreePage | TemplatePage;

// Far below the measured stack overflow (6,400 to 8,800 levels, varying run to run)
// and far above any content model's depth.
const MAXIMUM_TREE_DEPTH = 64;

export function extractTreeUsage(
  nodes: readonly ComponentNode[],
): ComponentUsage[] {
  const usage = new Map<string, ComponentUsage>();
  let position = 0;

  function visit(node: ComponentNode, depth: number): void {
    // `depth` counts levels below the root, so this node nests the tree past the limit.
    if (depth >= MAXIMUM_TREE_DEPTH) {
      // A plain `Error`, so the run exits 1: a too-deep tree is content, not wiring
      // (`docs/error-messages.md` rule 7).
      throw new Error(
        `Component tree: nests more than ${String(MAXIMUM_TREE_DEPTH)} levels deep at "${node.component}" — flatten the entry's tree`,
      );
    }
    const seen = usage.get(node.component);
    if (seen === undefined) {
      usage.set(node.component, {
        component: node.component,
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
    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  }

  for (const node of nodes) {
    visit(node, 0);
  }
  return [...usage.values()];
}

export const PRICING_PAGE_USAGE: readonly ComponentUsage[] = [
  {
    component: "PricingHeader",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  },
  { component: "PlanCard", count: 2, foldScore: 1, depth: 1, isRoot: false },
  { component: "FaqList", count: 1, foldScore: 3, depth: 0, isRoot: true },
];

export const SITE_FIXTURES: string = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "site",
);
