// The trees are shaped so a node's pre-order position and its child index disagree: a
// walk using the child index would pass on a flat tree.
import { expect, test } from "vitest";
import type { ComponentRegistry, ModuleFacts } from "@pagedeck/islands";
import { renderPage } from "./render.js";
import type { EntryNode } from "./tree.js";

const PAGE = { locale: "en", path: "/home" } as const;

function stub(name: string) {
  return { default: () => <div>{name}</div> };
}

const REGISTRY: ComponentRegistry = {
  defaulted: { import: async () => stub("defaulted") },
  declared_visible: {
    import: async () => stub("declared_visible"),
    hydrate: "visible",
  },
  declared_load: { import: async () => stub("declared_load"), hydrate: "load" },
  static_block: { import: async () => stub("static_block") },
};

const MODULES: Readonly<Record<string, ModuleFacts>> = {
  defaulted: { useClient: true },
  declared_visible: { useClient: true },
  declared_load: { useClient: false },
  static_block: { useClient: false },
};

function node(component: string, children?: readonly EntryNode[]): EntryNode {
  return children === undefined ? { component } : { component, children };
}

async function modesOf(
  tree: readonly EntryNode[],
  foldStrategy?: { threshold: number },
): Promise<readonly (readonly [string, string])[]> {
  const rendered = await renderPage({
    tree,
    page: PAGE,
    registry: REGISTRY,
    modules: MODULES,
    ...(foldStrategy === undefined ? {} : { foldStrategy }),
  });
  return rendered.islands.map((island) => [island.component, island.mode]);
}

test("a directive-defaulted visible above the fold hydrates on load", async () => {
  expect(
    await modesOf([node("defaulted"), node("static_block")], { threshold: 4 }),
  ).toEqual([["defaulted", "load"]]);
});

test("an explicitly declared load below the fold hydrates on visible", async () => {
  // One container with four children, not five siblings, so the count under test is the
  // pre-order one.
  const tree = [
    node("static_block", [
      node("static_block"),
      node("static_block"),
      node("static_block"),
      node("static_block"),
    ]),
    node("declared_load"),
  ];

  expect(await modesOf(tree, { threshold: 4 })).toEqual([
    ["declared_load", "visible"],
  ]);
});

test("an explicitly declared visible above the fold is not promoted", async () => {
  expect(
    await modesOf([node("declared_visible"), node("static_block")], {
      threshold: 4,
    }),
  ).toEqual([["declared_visible", "visible"]]);
});

test("two instances of one component on one page can get two modes", async () => {
  const tree = [
    node("defaulted"),
    node("static_block", [
      node("static_block"),
      node("static_block"),
      node("static_block"),
    ]),
    node("defaulted"),
  ];

  expect(await modesOf(tree, { threshold: 4 })).toEqual([
    ["defaulted", "load"],
    ["defaulted", "visible"],
  ]);
});

test("a position counts every node ahead of it, not every sibling", async () => {
  const deep = [
    node("static_block", [
      node("static_block", [node("static_block"), node("static_block")]),
      node("static_block"),
    ]),
    node("defaulted"),
  ];

  expect(await modesOf(deep, { threshold: 4 })).toEqual([
    ["defaulted", "visible"],
  ]);
  const shallow = [
    node("static_block", [node("static_block"), node("static_block")]),
    node("defaulted"),
  ];
  expect(await modesOf(shallow, { threshold: 4 })).toEqual([
    ["defaulted", "load"],
  ]);
});

test("an island nested inside another island is positioned by the same walk", async () => {
  const tree = [node("defaulted", [node("defaulted")])];

  expect(await modesOf(tree, { threshold: 4 })).toEqual([
    ["defaulted", "load"],
    ["defaulted", "load"],
  ]);
});

test("no fold strategy leaves declared and defaulted modes exactly as they were", async () => {
  const tree = [
    node("defaulted"),
    node("declared_visible"),
    node("declared_load"),
  ];

  expect(await modesOf(tree)).toEqual([
    ["defaulted", "visible"],
    ["declared_visible", "visible"],
    ["declared_load", "load"],
  ]);
});

test("the marker carries the tuned mode, not the mode the registry resolved", async () => {
  const rendered = await renderPage({
    tree: [node("defaulted"), node("static_block")],
    page: PAGE,
    registry: REGISTRY,
    modules: MODULES,
    foldStrategy: { threshold: 4 },
  });

  expect(rendered.html).toContain('data-fw-mode="load"');
  expect(rendered.html).not.toContain('data-fw-mode="visible"');
});

test("a page whose whole tree is one node is not promoted", async () => {
  expect(await modesOf([node("defaulted")], { threshold: 4 })).toEqual([
    ["defaulted", "visible"],
  ]);

  expect(
    await modesOf([node("defaulted"), node("static_block")], { threshold: 4 }),
  ).toEqual([["defaulted", "load"]]);
});

test("a single-node tree's own children make it promotable", async () => {
  expect(
    await modesOf([node("defaulted", [node("static_block")])], { threshold: 4 }),
  ).toEqual([["defaulted", "load"]]);
});

test("a tuned instance records what moved it", async () => {
  const tree = [
    node("defaulted"),
    node("static_block", [
      node("static_block"),
      node("static_block"),
      node("static_block"),
    ]),
    node("declared_load"),
  ];

  const rendered = await renderPage({
    tree,
    page: PAGE,
    registry: REGISTRY,
    modules: MODULES,
    foldStrategy: { threshold: 4 },
  });

  expect(rendered.islands.map((island) => island.foldAdjustment)).toEqual([
    { component: "defaulted", position: 0, from: "visible", to: "load" },
    { component: "declared_load", position: 5, from: "load", to: "visible" },
  ]);
});

test("an untuned instance records nothing", async () => {
  const rendered = await renderPage({
    tree: [node("declared_visible"), node("static_block")],
    page: PAGE,
    registry: REGISTRY,
    modules: MODULES,
    foldStrategy: { threshold: 4 },
  });

  expect(rendered.islands[0]?.foldAdjustment).toBeUndefined();
});
