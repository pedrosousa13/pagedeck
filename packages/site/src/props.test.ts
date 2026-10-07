import { expect, test } from "vitest";
import { isAboveFold, resolveFoldStrategy } from "@pagedeck/core";
import type { EntryNode } from "@pagedeck/core";
import { DRAFT_ENTRIES, PUBLISHED_ENTRIES } from "./content.js";
import type { Block, PageEntry } from "./content.js";
import { SITE_IMAGES } from "./images.js";
import { pageContentOf, propsOf } from "./props.js";
import type { PageRenderContext, PropsContext } from "./props.js";

function renderContext(entry: PageEntry): PageRenderContext {
  return {
    images: SITE_IMAGES,
    page: { locale: entry.locale, path: `/${entry.path}` },
    trailingSlash: "always",
    fold: resolveFoldStrategy(undefined),
  };
}

function nodeContext(
  entry: PageEntry,
  aboveFold: boolean,
): PropsContext {
  const { images, page, trailingSlash } = renderContext(entry);
  return { images, page, trailingSlash, aboveFold };
}

function entry(locale: string, path: string): PageEntry {
  const found = PUBLISHED_ENTRIES.find(
    (row) => row.locale === locale && row.path === path,
  );
  if (found === undefined) {
    throw new Error(
      `Site content: holds no entry /${locale}/${path} — it holds ${PUBLISHED_ENTRIES.map(
        (row) => `/${row.locale}/${row.path}`,
      ).join(", ")}`,
    );
  }
  return found;
}

function nodes(tree: readonly Block[]): Block[] {
  return tree.flatMap((node) => [node, ...nodes(node.children)]);
}

test("a link field becomes the href the component reads, spelled by the framework", () => {
  const home = entry("en", "home").data;
  if (home.mode !== "tree") throw new Error("en/home is not a tree entry");
  const button = nodes(home.tree).find((node) => node.component === "button");
  expect(button?.props).toHaveProperty("link");
  expect(button?.props).not.toHaveProperty("href");

  const props = propsOf(button as Block, nodeContext(entry("en", "home"), false));
  expect(props["href"]).toBe("/en/pricing/");
  expect(props).not.toHaveProperty("link");
  expect(props["label"]).toBe("See pricing");
});

test("a field that is not a link or an image is passed through as the entry stores it", () => {
  const home = entry("en", "home").data;
  if (home.mode !== "tree") throw new Error("en/home is not a tree entry");
  const hero = nodes(home.tree).find((node) => node.component === "hero");
  // Not `toEqual` over the record: the hero's image field is supposed to be rewritten.
  const props = propsOf(hero as Block, nodeContext(entry("en", "home"), false));
  expect(props["headline"]).toBe((hero as Block).props["headline"]);
});

test("an image field becomes the attribute set an <img> is spread with", () => {
  const home = entry("en", "home").data;
  if (home.mode !== "tree") throw new Error("en/home is not a tree entry");
  const hero = nodes(home.tree).find((node) => node.component === "hero");
  expect((hero as Block).props["image"]).toHaveProperty("kind", "image");

  const props = propsOf(hero as Block, nodeContext(entry("en", "home"), true));
  expect(props["image"]).toEqual({
    src: "/images/uploads/hero.jpg-1280.webp",
    srcSet: [
      "/images/uploads/hero.jpg-320.webp 320w",
      "/images/uploads/hero.jpg-640.webp 640w",
      "/images/uploads/hero.jpg-1280.webp 1280w",
    ].join(", "),
    sizes: "100vw",
    width: 2400,
    height: 1350,
    loading: "eager",
    fetchPriority: "high",
    alt: "A build finishing in a terminal",
  });
  expect(props["image"]).not.toHaveProperty("kind");
});

test("an image below the fold is lazy and carries no priority claim", () => {
  const home = entry("en", "home").data;
  if (home.mode !== "tree") throw new Error("en/home is not a tree entry");
  const hero = nodes(home.tree).find((node) => node.component === "hero");
  const props = propsOf(hero as Block, nodeContext(entry("en", "home"), false));
  expect(props["image"]).toMatchObject({
    loading: "lazy",
    fetchPriority: "auto",
  });
});

test("the fold verdict a whole entry gets is its node's position in that entry", () => {
  // `en/home` is five nodes, so its hero at position 0 is above the default fold of 4;
  // `de/home` is one node, and a tree of one is never above the fold.
  const en = entry("en", "home");
  const de = entry("de", "home");
  const heroOf = (row: PageEntry): Record<string, unknown> => {
    const content = pageContentOf(row.data, renderContext(row));
    const hero = content.tree?.[0];
    if (hero === undefined) {
      throw new Error(`/${row.locale}/${row.path} rendered no tree node`);
    }
    return (hero.props ?? {})["image"] as Record<string, unknown>;
  };
  expect(heroOf(en)).toMatchObject({ loading: "eager", fetchPriority: "high" });
  expect(heroOf(de)).toMatchObject({ loading: "lazy", fetchPriority: "auto" });
  expect(heroOf(de)["src"]).toBe(heroOf(en)["src"]);
});

test("entry metadata reaches template props, beside the fields rather than inside them", () => {
  const row = entry("en", "legal/terms");
  const content = pageContentOf(row.data, renderContext(row));
  if (content.template === undefined) {
    throw new Error("the legal entry did not render in template mode");
  }
  expect(content.template).toBe("legal_page");
  expect(content.props?.["title"]).toBe("Terms");
  expect(content.props?.["fields"]).toMatchObject({ body_text: "The terms." });
});

test("an unset link becomes no prop at all, so no anchor is rendered", () => {
  const legal = entry("en", "legal/terms");
  const terms = legal.data;
  if (terms.mode !== "template") {
    throw new Error("the legal entry is not a template entry");
  }
  expect(terms.fields).toHaveProperty("unset_link");

  const content = pageContentOf(terms, renderContext(legal));
  if (content.template === undefined) {
    throw new Error("the legal entry did not render in template mode");
  }
  const fields = content.props?.["fields"] as Record<string, unknown>;
  expect(fields).not.toHaveProperty("unset_link");
  expect(fields["related"]).toBe("/en/pricing/");
});

test("no prop the step produces still holds a link field, in either entry set", () => {
  const faults: string[] = [];
  const check = (
    at: string,
    props: Readonly<Record<string, unknown>>,
  ): void => {
    for (const [field, value] of Object.entries(props)) {
      const kind =
        typeof value === "object" && value !== null
          ? (value as { kind?: unknown }).kind
          : undefined;
      if (kind !== undefined) {
        faults.push(`  ${at}: "${field}" is still a ${String(kind)} field`);
      }
    }
  };
  for (const [version, entries] of [
    ["published", PUBLISHED_ENTRIES],
    ["draft", DRAFT_ENTRIES],
  ] as const) {
    for (const row of entries) {
      const at = `/${version}/${row.locale}/${row.path}`;
      if (row.data.mode === "tree") {
        for (const node of nodes(row.data.tree)) {
          check(
            `${at} ${node.component}`,
            propsOf(node, nodeContext(row, false)),
          );
        }
        continue;
      }
      const content = pageContentOf(row.data, renderContext(row));
      if (content.template === undefined) continue;
      check(
        `${at} ${row.data.template}`,
        content.props?.["fields"] as Record<string, unknown>,
      );
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

// A threshold of 1, not the site's 4: the default absorbs an off-by-one, so the test
// could not fail on a numbering that had drifted (#299).
test("the tree a site numbers is the tree it emits, node for node", () => {
  const strategy = resolveFoldStrategy({ threshold: 1 });
  if (strategy === undefined) throw new Error("threshold 1 resolved to nothing");
  const componentsOf = (nodes: readonly Block[]): string[] =>
    nodes.flatMap((node) => [node.component, ...componentsOf(node.children)]);
  const emitted = (nodes: readonly EntryNode[]): string[] =>
    nodes.flatMap((node) => [node.component, ...emitted(node.children ?? [])]);

  for (const row of PUBLISHED_ENTRIES) {
    if (row.data.mode !== "tree") continue;
    const at = `/${row.locale}/${row.path}`;
    const content = pageContentOf(row.data, {
      ...renderContext(row),
      fold: strategy,
    });

    expect(`${at} ${emitted(content.tree ?? []).join(" ")}`).toBe(
      `${at} ${componentsOf(row.data.tree).join(" ")}`,
    );

    const treeSize = componentsOf(row.data.tree).length;
    emitted(content.tree ?? []).forEach((_component, position) => {
      const node = nodeAt(content.tree ?? [], position);
      const image = (node.props ?? {})["image"] as
        | Record<string, unknown>
        | undefined;
      if (image === undefined) return;
      expect(`${at} ${position} ${image["loading"] as string}`).toBe(
        `${at} ${position} ${
          isAboveFold({ position, treeSize, strategy }) ? "eager" : "lazy"
        }`,
      );
    });
  }
});

function nodeAt(nodes: readonly EntryNode[], position: number): EntryNode {
  const flat: EntryNode[] = [];
  const visit = (node: EntryNode): void => {
    flat.push(node);
    (node.children ?? []).forEach(visit);
  };
  nodes.forEach(visit);
  const found = flat[position];
  if (found === undefined) throw new Error(`no node at position ${position}`);
  return found;
}
