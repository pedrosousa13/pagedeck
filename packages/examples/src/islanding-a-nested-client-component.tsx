// Example: island a `"use client"` component no entry names, through `clientReference`. In a
// real site `pagedeck build` substitutes the stand-ins; this example does it by hand.
import { clientReference, renderPage } from "@pagedeck/core";
import { LikeButton, Tabs, ThemeProvider } from "./site-components.js";
import type { ComponentRegistry } from "@pagedeck/islands";

// `PageContext.path`, rooted; the store keys this page as `article`.
const PAGE = { locale: "en", path: "/article" } as const;

// One stand-in per client component; `name` is what the marker carries.
const ProxiedLikeButton = clientReference(LikeButton, {
  name: "LikeButton",
  mode: "visible",
});
const ProxiedTabs = clientReference(Tabs, { name: "Tabs", mode: "load" });

// In a site this would import `LikeButton`; the build's loader makes that import the stand-in.
function ArticleFooter({ title }: { title: string }) {
  return (
    <footer className="article">
      <h2>{title}</h2>
      <ProxiedLikeButton count={12} />
    </footer>
  );
}

/** The same template, wrong on purpose: JSX children on a client component. */
function BadFooter() {
  return (
    <ProxiedTabs open={0}>
      <p>panel</p>
    </ProxiedTabs>
  );
}

export interface NestedIsland {
  component: string;
  prefix: string;
  mode: string;
  /** Absent here, and that absence is the point: no entry node, no position. */
  path?: readonly number[];
}

export interface NestedClientComponentExample {
  html: string;
  islands: readonly NestedIsland[];
  refusedChildren: string;
}

export async function islandNestedClientComponent(): Promise<NestedClientComponentExample> {
  // Only the template is registered: no entry can name the client component.
  const registry = {
    ArticleFooter: { import: async () => ({ default: ArticleFooter }) },
    BadFooter: { import: async () => ({ default: BadFooter }) },
  } satisfies ComponentRegistry;

  const { html, islands } = await renderPage({
    page: PAGE,
    template: "ArticleFooter",
    props: { title: "Ship faster" },
    registry,
    providers: [{ component: ThemeProvider, props: { theme: "dark" } }],
  });

  let refusedChildren = "no error";
  try {
    await renderPage({ page: PAGE, template: "BadFooter", registry });
  } catch (error) {
    refusedChildren = (error as Error).message;
  }

  return {
    html,
    islands: islands.map((island) => ({
      component: island.component,
      prefix: island.prefix,
      mode: island.mode,
      path: island.path,
    })),
    refusedChildren,
  };
}
