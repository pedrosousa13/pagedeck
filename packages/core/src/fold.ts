import type { HydrationMode, ResolvedHydration } from "@pagedeck/islands";

export const DEFAULT_FOLD_THRESHOLD = 4;

export type FoldStrategySetting = boolean | { readonly threshold?: number };

export interface FoldStrategy {
  readonly threshold: number;
}

export function resolveFoldStrategy(
  declared: FoldStrategySetting | undefined,
): FoldStrategy | undefined {
  if (declared === false) return undefined;
  if (declared === undefined || declared === true) {
    return { threshold: DEFAULT_FOLD_THRESHOLD };
  }
  return { threshold: declared.threshold ?? DEFAULT_FOLD_THRESHOLD };
}

export function isAboveFold(input: {
  position: number;
  treeSize: number;
  strategy: FoldStrategy;
}): boolean {
  return input.treeSize > 1 && input.position < input.strategy.threshold;
}

export interface FoldPosition<Node> {
  readonly node: Node;
  readonly position: number;
  readonly treeSize: number;
  readonly children: readonly FoldPosition<Node>[];
}

export function foldPositions<Node>(
  nodes: readonly Node[],
  childrenOf: (node: Node) => readonly Node[] | undefined,
): FoldPosition<Node>[] {
  const treeSize = countNodes(nodes, childrenOf);
  // Taken before the children are walked: the numbering is pre-order.
  let at = 0;
  const number = (node: Node): FoldPosition<Node> => {
    const position = at;
    at += 1;
    return {
      node,
      position,
      treeSize,
      children: (childrenOf(node) ?? []).map(number),
    };
  };
  return nodes.map(number);
}

function countNodes<Node>(
  nodes: readonly Node[],
  childrenOf: (node: Node) => readonly Node[] | undefined,
): number {
  return nodes.reduce(
    (total, node) => total + 1 + countNodes(childrenOf(node) ?? [], childrenOf),
    0,
  );
}

export interface FoldAdjustment {
  component: string;
  position: number;
  from: Exclude<HydrationMode, "none">;
  to: Exclude<HydrationMode, "none">;
}

export interface TunedHydration {
  mode: HydrationMode;
  adjustment?: FoldAdjustment;
}

export function tuneHydration(input: {
  component: string;
  resolved: ResolvedHydration;
  position: number;
  treeSize: number;
  strategy: FoldStrategy;
}): TunedHydration {
  const { component, position, treeSize, strategy } = input;
  const { mode, source } = input.resolved;
  // Two comparisons, not `!aboveFold`: on a single-node tree neither holds.
  const belowFold = position >= strategy.threshold;
  const aboveFold = isAboveFold({ position, treeSize, strategy });

  if (mode === "visible" && source === "defaulted" && aboveFold) {
    return {
      mode: "load",
      adjustment: { component, position, from: "visible", to: "load" },
    };
  }
  if (mode === "load" && source === "declared" && belowFold) {
    return {
      mode: "visible",
      adjustment: { component, position, from: "load", to: "visible" },
    };
  }
  return { mode };
}

export function foldCause(
  adjustment: FoldAdjustment,
  strategy: FoldStrategy,
): string {
  const promoted = adjustment.to === "load";
  const position = String(adjustment.position);
  return `fold strategy ${promoted ? "promoted" : "demoted"} "${adjustment.component}" at tree position ${position} from "${adjustment.from}" to "${adjustment.to}" — position ${position} is ${promoted ? "above" : "below"} the fold threshold of ${String(strategy.threshold)}`;
}

/**
 * The examples are deliberately not `DEFAULT_FOLD_THRESHOLD`: a copied fix must
 * change something (rule 3).
 */
const SHAPE_FIX =
  "write foldStrategy: false to turn fold-driven hydration off, or foldStrategy: { threshold: 8 } to tune it";
const THRESHOLD_FIX =
  "write a whole number of nodes, 0 or more, such as { threshold: 8 }";
const UNKNOWN_FIX =
  'delete the field, or correct it to "threshold", the only field foldStrategy takes';

export function foldStrategyFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.foldStrategy" must be true, false, or an object with a threshold — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];

  const unknown = Object.keys(record).filter((key) => key !== "threshold");
  if (unknown.length > 0) {
    const subject =
      unknown.length === 1
        ? "declares 1 field this build does not read"
        : `declares ${String(unknown.length)} fields this build does not read`;
    const lines = unknown.map((key) => `  ${JSON.stringify(key)}`).join("\n");
    sections.push(
      `${where}: "build.foldStrategy" ${subject} — ${UNKNOWN_FIX}:\n${lines}`,
    );
  }

  const threshold = Object.hasOwn(record, "threshold")
    ? record["threshold"]
    : undefined;
  const reason = threshold === undefined ? undefined : thresholdFault(threshold);
  if (reason !== undefined) {
    sections.push(
      `${where}: "build.foldStrategy" declares a threshold that is not a tree position — ${THRESHOLD_FIX}:\n  ${JSON.stringify(threshold)} — ${reason}`,
    );
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function thresholdFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and a tree position counts nodes";
  }
  if (value < 0) return "below zero, and the first node of a tree is at position 0";
  return undefined;
}
