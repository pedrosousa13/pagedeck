import { expect, test } from "vitest";
import {
  DEFAULT_FOLD_THRESHOLD,
  foldCause,
  foldPositions,
  foldStrategyFaultReport,
  isAboveFold,
  resolveFoldStrategy,
  tuneHydration,
} from "./fold.js";

const AT_TEN = { threshold: 10 };

const PAGE_SIZED = 40;

test("a directive-defaulted visible above the fold is promoted to load", () => {
  const tuned = tuneHydration({
    component: "lead_form",
    resolved: { mode: "visible", source: "defaulted" },
    position: 2,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("load");
  expect(tuned.adjustment).toEqual({
    component: "lead_form",
    position: 2,
    from: "visible",
    to: "load",
  });
});

test("a directive-defaulted visible below the fold is left alone", () => {
  const tuned = tuneHydration({
    component: "lead_form",
    resolved: { mode: "visible", source: "defaulted" },
    position: 10,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("visible");
  expect(tuned.adjustment).toBeUndefined();
});

test("the threshold is the first position below the fold, not the last above it", () => {
  const inside = tuneHydration({
    component: "lead_form",
    resolved: { mode: "visible", source: "defaulted" },
    position: 9,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(inside.mode).toBe("load");
});

test("an explicitly declared visible above the fold is not promoted", () => {
  const tuned = tuneHydration({
    component: "carousel",
    resolved: { mode: "visible", source: "declared" },
    position: 0,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("visible");
  expect(tuned.adjustment).toBeUndefined();
});

test("an explicitly declared load below the fold is demoted to visible", () => {
  const tuned = tuneHydration({
    component: "newsletter",
    resolved: { mode: "load", source: "declared" },
    position: 31,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("visible");
  expect(tuned.adjustment).toEqual({
    component: "newsletter",
    position: 31,
    from: "load",
    to: "visible",
  });
});

test("an explicitly declared load above the fold keeps its load", () => {
  const tuned = tuneHydration({
    component: "newsletter",
    resolved: { mode: "load", source: "declared" },
    position: 1,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("load");
  expect(tuned.adjustment).toBeUndefined();
});

test("none is never altered in either direction", () => {
  for (const position of [0, 99]) {
    for (const source of ["declared", "defaulted"] as const) {
      const tuned = tuneHydration({
        component: "hero",
        resolved: { mode: "none", source },
        position,
        treeSize: PAGE_SIZED,
        strategy: AT_TEN,
      });

      expect(tuned.mode).toBe("none");
      expect(tuned.adjustment).toBeUndefined();
    }
  }
});

test("idle is never altered in either direction", () => {
  for (const position of [0, 99]) {
    const tuned = tuneHydration({
      component: "carousel",
      resolved: { mode: "idle", source: "declared" },
      position,
      treeSize: PAGE_SIZED,
      strategy: AT_TEN,
    });

    expect(tuned.mode).toBe("idle");
    expect(tuned.adjustment).toBeUndefined();
  }
});

test("interaction is never altered in either direction", () => {
  for (const position of [0, 99]) {
    const tuned = tuneHydration({
      component: "search",
      resolved: { mode: "interaction", source: "declared" },
      position,
      treeSize: PAGE_SIZED,
      strategy: AT_TEN,
    });

    expect(tuned.mode).toBe("interaction");
    expect(tuned.adjustment).toBeUndefined();
  }
});

test("nothing is ever promoted past load", () => {
  const tuned = tuneHydration({
    component: "lead_form",
    resolved: { mode: "visible", source: "defaulted" },
    position: 0,
    treeSize: PAGE_SIZED,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("load");
});

test("a threshold of zero puts every instance below the fold", () => {
  const defaulted = tuneHydration({
    component: "lead_form",
    resolved: { mode: "visible", source: "defaulted" },
    position: 0,
    treeSize: PAGE_SIZED,
    strategy: { threshold: 0 },
  });
  const declared = tuneHydration({
    component: "newsletter",
    resolved: { mode: "load", source: "declared" },
    position: 0,
    treeSize: PAGE_SIZED,
    strategy: { threshold: 0 },
  });

  expect(defaulted.mode).toBe("visible");
  expect(declared.mode).toBe("visible");
});

test("the site's setting resolves to a strategy or to nothing", () => {
  expect(resolveFoldStrategy(undefined)).toEqual({
    threshold: DEFAULT_FOLD_THRESHOLD,
  });
  expect(resolveFoldStrategy(true)).toEqual({
    threshold: DEFAULT_FOLD_THRESHOLD,
  });
  expect(resolveFoldStrategy(false)).toBeUndefined();
  expect(resolveFoldStrategy({})).toEqual({ threshold: DEFAULT_FOLD_THRESHOLD });
  expect(resolveFoldStrategy({ threshold: 3 })).toEqual({ threshold: 3 });
});

test("the default threshold is chosen against a mobile viewport", () => {
  expect(DEFAULT_FOLD_THRESHOLD).toBe(4);
});

test("a single-node tree is not promoted, whatever the threshold", () => {
  const tuned = tuneHydration({
    component: "pricing_page",
    resolved: { mode: "visible", source: "defaulted" },
    position: 0,
    treeSize: 1,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("visible");
  expect(tuned.adjustment).toBeUndefined();
});

test("a two-node tree is promoted, so the rule is about one node and not about small pages", () => {
  const tuned = tuneHydration({
    component: "hero",
    resolved: { mode: "visible", source: "defaulted" },
    position: 0,
    treeSize: 2,
    strategy: AT_TEN,
  });

  expect(tuned.mode).toBe("load");
});

test("a single-node tree is still demoted by a threshold of zero", () => {
  const tuned = tuneHydration({
    component: "pricing_page",
    resolved: { mode: "load", source: "declared" },
    position: 0,
    treeSize: 1,
    strategy: { threshold: 0 },
  });

  expect(tuned.mode).toBe("visible");
  expect(
    tuneHydration({
      component: "pricing_page",
      resolved: { mode: "load", source: "declared" },
      position: 0,
      treeSize: 1,
      strategy: AT_TEN,
    }).mode,
  ).toBe("load");
});

test("a cause names the instance, the position, the move and the reason", () => {
  expect(
    foldCause(
      { component: "lead_form", position: 2, from: "visible", to: "load" },
      { threshold: 8 },
    ),
  ).toBe(
    'fold strategy promoted "lead_form" at tree position 2 from "visible" to "load" — position 2 is above the fold threshold of 8',
  );
  expect(
    foldCause(
      { component: "newsletter", position: 31, from: "load", to: "visible" },
      { threshold: 8 },
    ),
  ).toBe(
    'fold strategy demoted "newsletter" at tree position 31 from "load" to "visible" — position 31 is below the fold threshold of 8',
  );
});

const WHERE = 'Config "/site/pagedeck.config.ts"';

test("a usable foldStrategy reports no fault", () => {
  for (const value of [true, false, {}, { threshold: 0 }, { threshold: 12 }]) {
    expect(foldStrategyFaultReport(value, WHERE)).toBeUndefined();
  }
});

test("a foldStrategy that is neither a flag nor an object is refused alone", () => {
  expect(foldStrategyFaultReport("on", WHERE)).toBe(
    `${WHERE}: "build.foldStrategy" must be true, false, or an object with a threshold — write foldStrategy: false to turn fold-driven hydration off, or foldStrategy: { threshold: 8 } to tune it`,
  );
});

test("a threshold that is not a tree position is refused with its own reason", () => {
  expect(foldStrategyFaultReport({ threshold: "8" }, WHERE)).toBe(
    `${WHERE}: "build.foldStrategy" declares a threshold that is not a tree position — write a whole number of nodes, 0 or more, such as { threshold: 8 }:\n  "8" — not a number`,
  );
  expect(foldStrategyFaultReport({ threshold: 8.5 }, WHERE)).toBe(
    `${WHERE}: "build.foldStrategy" declares a threshold that is not a tree position — write a whole number of nodes, 0 or more, such as { threshold: 8 }:\n  8.5 — not a whole number, and a tree position counts nodes`,
  );
  expect(foldStrategyFaultReport({ threshold: -1 }, WHERE)).toBe(
    `${WHERE}: "build.foldStrategy" declares a threshold that is not a tree position — write a whole number of nodes, 0 or more, such as { threshold: 8 }:\n  -1 — below zero, and the first node of a tree is at position 0`,
  );
});

test("a key this build does not read is refused rather than ignored", () => {
  expect(foldStrategyFaultReport({ treshold: 4 }, WHERE)).toBe(
    `${WHERE}: "build.foldStrategy" declares 1 field this build does not read — delete the field, or correct it to "threshold", the only field foldStrategy takes:\n  "treshold"`,
  );
  expect(foldStrategyFaultReport({ treshold: 4, enabled: true }, WHERE)).toBe(
    `${WHERE}: "build.foldStrategy" declares 2 fields this build does not read — delete the field, or correct it to "threshold", the only field foldStrategy takes:\n  "treshold"\n  "enabled"`,
  );
});

test("a misspelled key and a bad threshold are reported in one run", () => {
  const report = foldStrategyFaultReport(
    { threshold: "8", enabled: true },
    WHERE,
  );

  expect(report).toContain("declares 1 field this build does not read");
  expect(report).toContain('"8" — not a number');
  expect(report?.split("\n\n")).toHaveLength(2);
});

test("a threshold quoted by JSON keeps a string distinguishable from a number", () => {
  const quoted = foldStrategyFaultReport({ threshold: "8" }, WHERE);

  expect(quoted).toContain('"8" — not a number');
  expect(quoted).not.toContain("  8 — not a number");
});

test("the fold rule answers about a position, for the images that ask it directly", () => {
  expect(
    isAboveFold({ position: 2, treeSize: PAGE_SIZED, strategy: AT_TEN }),
  ).toBe(true);
  expect(
    isAboveFold({ position: 10, treeSize: PAGE_SIZED, strategy: AT_TEN }),
  ).toBe(false);
  expect(isAboveFold({ position: 0, treeSize: 1, strategy: AT_TEN })).toBe(
    false,
  );
});

interface NamedNode {
  name: string;
  children?: readonly NamedNode[];
}

const NESTED: readonly NamedNode[] = [
  { name: "hero", children: [{ name: "cta" }] },
  { name: "grid", children: [{ name: "card" }] },
];

test("a tree is numbered pre-order, so a node's children come before its next sibling", () => {
  const [hero, grid] = foldPositions(NESTED, (node) => node.children);

  expect(hero?.position).toBe(0);
  expect(hero?.children[0]?.node.name).toBe("cta");
  expect(hero?.children[0]?.position).toBe(1);
  expect(grid?.node.name).toBe("grid");
  expect(grid?.position).toBe(2);
  expect(grid?.children[0]?.position).toBe(3);
});

test("every numbered node carries the whole tree's size, not its own subtree's", () => {
  const [hero, grid] = foldPositions(NESTED, (node) => node.children);

  expect(hero?.treeSize).toBe(4);
  expect(hero?.children[0]?.treeSize).toBe(4);
  expect(grid?.children[0]?.treeSize).toBe(4);
});

test("children are read through the caller's own accessor, not off a field name", () => {
  const blocks = [
    { id: "a", blocks: [{ id: "b", blocks: [] }] },
    { id: "c", blocks: [] },
  ];

  const numbered = foldPositions(blocks, (node) => node.blocks);

  expect(numbered[0]?.children[0]?.node.id).toBe("b");
  expect(numbered[0]?.children[0]?.position).toBe(1);
  expect(numbered[1]?.position).toBe(2);
  expect(numbered[1]?.treeSize).toBe(3);
});

test("an empty tree is numbered to nothing", () => {
  expect(foldPositions([], (node: NamedNode) => node.children)).toEqual([]);
});

test("a numbered node answers the fold rule on its own", () => {
  const [hero, grid] = foldPositions(NESTED, (node) => node.children);

  expect(
    isAboveFold({
      position: hero?.position ?? -1,
      treeSize: hero?.treeSize ?? 0,
      strategy: { threshold: 2 },
    }),
  ).toBe(true);
  expect(
    isAboveFold({
      position: grid?.position ?? -1,
      treeSize: grid?.treeSize ?? 0,
      strategy: { threshold: 2 },
    }),
  ).toBe(false);
});
