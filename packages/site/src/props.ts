import {
  canonicalizePath,
  foldPositions,
  imageAttributes,
  isAboveFold,
} from "@pagedeck/core";
import type {
  EntryNode,
  FoldPosition,
  FoldStrategy,
  ImagesSetting,
  PageContent,
} from "@pagedeck/core";
import type { PageContext } from "@pagedeck/islands";
import type {
  Block,
  Field,
  ImageField,
  LinkField,
  PageData,
} from "./content.js";

export interface PropsContext {
  readonly images: ImagesSetting;
  readonly page: PageContext;
  readonly aboveFold: boolean;
}

export type PageRenderContext = Omit<PropsContext, "aboveFold"> & {
  readonly fold: FoldStrategy | undefined;
};

const PROP_NAMES: Readonly<Record<string, string>> = { link: "href" };

function hasKind(value: Field): value is ImageField | LinkField {
  return typeof value === "object" && !Array.isArray(value);
}

function imageOf(
  image: ImageField,
  context: PropsContext,
): Record<string, unknown> {
  return {
    ...imageAttributes({
      images: context.images,
      image: {
        src: image.src,
        width: image.width,
        height: image.height,
        aboveFold: context.aboveFold,
      },
      page: context.page,
    }),
    alt: image.alt,
  };
}

function fieldsOf(
  fields: Readonly<Record<string, Field>>,
  context: PropsContext,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!hasKind(value)) {
      props[field] = value;
      continue;
    }
    switch (value.kind) {
      case "image":
        props[PROP_NAMES[field] ?? field] = imageOf(value, context);
        break;
      case "link":
        // An unset link becomes no prop, so no anchor renders.
        if (value.to === null) break;
        props[PROP_NAMES[field] ?? field] = canonicalizePath(
          `/${value.to.locale}/${value.to.path}`,
        );
        break;
      default: {
        const exhaustive: never = value;
        throw new Error(`unknown field kind in ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return props;
}

export function propsOf(
  node: Block,
  context: PropsContext,
): Record<string, unknown> {
  return fieldsOf(node.props, context);
}

function entryNodesOf(
  nodes: readonly FoldPosition<Block>[],
  context: PageRenderContext,
): EntryNode[] {
  return nodes.map(({ node, position, treeSize, children }) => ({
    component: node.component,
    props: propsOf(node, {
      images: context.images,
      page: context.page,
      aboveFold:
        context.fold !== undefined &&
        isAboveFold({ position, treeSize, strategy: context.fold }),
    }),
    children: entryNodesOf(children, context),
  }));
}

// `...data` is what carries `title`: an entry's title sits beside `fields`, not in them.
export function pageContentOf(
  data: PageData,
  context: PageRenderContext,
): PageContent {
  if (data.mode === "tree") {
    return {
      tree: entryNodesOf(
        foldPositions(data.tree, (node) => node.children),
        context,
      ),
    };
  }
  return {
    template: data.template,
    // Never above the fold: a template is one node holding the whole page, so every
    // image on it would turn eager.
    props: {
      ...data,
      fields: fieldsOf(data.fields, { ...context, aboveFold: false }),
    },
  };
}
