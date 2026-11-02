// Example: island a `"use client"` component no entry names, through `clientReference`. In a
// real site `pagedeck build` substitutes the stand-ins; this example does it by hand.
import { clientReference, renderPage } from "@pagedeck/core";
import { LikeButton, ThemeProvider } from "./site-components.js";
import type { ReactNode } from "react";
import type { ComponentRegistry } from "@pagedeck/islands";

// `PageContext.path`, rooted; the store keys this page as `article`.
const PAGE = { locale: "en", path: "/article" } as const;

// One stand-in per client component; `name` is what the marker carries.
const ProxiedLikeButton = clientReference(LikeButton, {
  name: "LikeButton",
  mode: "visible",
});

// In a site this would import `LikeButton`; the build's loader makes that import the stand-in.
function ArticleFooter({ title }: { title: string }) {
  return (
    <footer className="article">
      <h2>{title}</h2>
      <ProxiedLikeButton count={12} />
    </footer>
  );
}

// Wrong on purpose: a client component that renders the element it is handed twice.
function Teaser({ children }: { children?: ReactNode }) {
  return (
    <details>
      <summary>{children}</summary>
      {children}
    </details>
  );
}

const ProxiedTeaser = clientReference(Teaser, { name: "Teaser", mode: "load" });

/** The same template, wrong on purpose: one prop slot placed in two places. */
function BadFooter() {
  return (
    <ProxiedTeaser>
      <p>panel</p>
    </ProxiedTeaser>
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
  twicePlacedSlot: string;
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

  let twicePlacedSlot = "no error";
  try {
    await renderPage({ page: PAGE, template: "BadFooter", registry });
  } catch (error) {
    twicePlacedSlot = (error as Error).message;
  }

  return {
    html,
    islands: islands.map((island) => ({
      component: island.component,
      prefix: island.prefix,
      mode: island.mode,
      path: island.path,
    })),
    twicePlacedSlot,
  };
}
