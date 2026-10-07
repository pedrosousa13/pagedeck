import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openStore } from "@pagedeck/content";
import type { ContentStore } from "@pagedeck/content";
import type { ComponentRegistry } from "@pagedeck/islands";
import { ConfigError } from "./exit.js";
import { defineLocales } from "./locales.js";
import { contentOf, layoutContents } from "./layout.js";
import { collectPages, definePages, fromCollection } from "./pages.js";
import type { Page } from "./pages.js";
import { RenderError } from "./tree.js";

const openStores: ContentStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const inertLoader = {
  syncAll: () => ({ changed: [], deleted: [], cursor: 0 }),
  syncSince: () => ({ changed: [], deleted: [], cursor: 0 }),
};

const component = { import: () => Promise.resolve({}) };

const REGISTRY: ComponentRegistry = {
  layout: component,
  counter: component,
  toggle: component,
};

function siteOf(entries: Readonly<Record<string, unknown>>): {
  store: ContentStore;
  pages: Page[];
} {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-layout-"));
  tempDirs.push(dir);
  const store = openStore(join(dir, "content.db"));
  openStores.push(store);
  for (const [path, data] of Object.entries(entries)) {
    store.upsertEntry({ collection: "pages", locale: "en", path, data });
  }
  const collection = { name: "pages", loader: inertLoader, schema: false as const };
  const pages = collectPages(
    store,
    definePages({ sources: [fromCollection(collection, { layout: "layout" })] }),
  );
  return { store, pages };
}

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, but it returned");
}

test("an entry renders into its layout with its title and html as props", () => {
  const { store, pages } = siteOf({
    about: { title: "About", html: "<p>Hi</p>", frontmatter: {} },
  });

  const contents = layoutContents(pages, store, REGISTRY);

  expect([...contents.values()]).toEqual([
    {
      tree: [
        {
          component: "layout",
          props: { title: "About", html: "<p>Hi</p>" },
          children: [],
        },
      ],
    },
  ]);
});

test("frontmatter components become the layout's children, in order and with no props", () => {
  const { store, pages } = siteOf({
    counter: {
      title: "Counter",
      html: "<p>Count</p>",
      frontmatter: { components: ["toggle", "counter", "toggle"] },
    },
  });

  const [content] = layoutContents(pages, store, REGISTRY).values();

  expect(content?.tree?.[0]?.children).toEqual([
    { component: "toggle" },
    { component: "counter" },
    { component: "toggle" },
  ]);
});

test("an entry with no html fails, naming the entry and the shape a layout renders", () => {
  const { store, pages } = siteOf({
    broken: { title: "Broken", frontmatter: {} },
  });

  const failure = failureOf(() => layoutContents(pages, store, REGISTRY));

  expect(failure).toBeInstanceOf(RenderError);
  expect(failure.message).toBe(
    `Collection "pages": 1 entry does not have the shape a layout renders — give each a string title and html, and a list at frontmatter.components if it has one, as the markdown loader writes them, or render the collection through a content callback instead:
  /en/broken — html is not a string`,
  );
});

test("every entry a layout cannot render is named, with every field each one lacks", () => {
  const { store, pages } = siteOf({
    a: { html: 3 },
    b: "<p>not an object</p>",
    c: { title: "C", html: "<p>C</p>", frontmatter: { components: "counter" } },
  });

  const failure = failureOf(() => layoutContents(pages, store, REGISTRY));

  expect(failure.message).toBe(
    `Collection "pages": 3 entries do not have the shape a layout renders — give each a string title and html, and a list at frontmatter.components if it has one, as the markdown loader writes them, or render the collection through a content callback instead:
  /en/a — title is not a string, html is not a string
  /en/b — title is not a string, html is not a string
  /en/c — frontmatter.components is not a list`,
  );
});

test("a frontmatter component nobody registered fails, naming the entry, every unknown name and the registered ones", () => {
  const { store, pages } = siteOf({
    counter: {
      title: "Counter",
      html: "",
      frontmatter: { components: ["counter", "./x.js", "@scope/pkg"] },
    },
    other: {
      title: "Other",
      html: "",
      frontmatter: { components: ["constructor", "__proto__", "toString"] },
    },
  });

  const failure = failureOf(() => layoutContents(pages, store, REGISTRY));

  expect(failure).toBeInstanceOf(RenderError);
  expect(failure.message).toBe(
    `Collection "pages": 2 entries name components at frontmatter.components that build.components does not register — name only registered components, which are "counter", "layout", "toggle":
  /en/counter — "./x.js", "@scope/pkg"
  /en/other — "constructor", "__proto__", "toString"`,
  );
});

test("a fallback page renders the entry it falls back to, and a fault in that entry is named once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-layout-"));
  tempDirs.push(dir);
  const store = openStore(join(dir, "content.db"));
  openStores.push(store);
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "about",
    data: { title: "About" },
  });
  const collection = { name: "pages", loader: inertLoader, schema: false as const };
  const pages = collectPages(
    store,
    definePages({
      sources: [fromCollection(collection, { layout: "layout" })],
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
        de: { label: "Deutsch", direction: "ltr", fallback: "en" },
      }),
    }),
  );

  const failure = failureOf(() => layoutContents(pages, store, REGISTRY));

  expect(pages).toHaveLength(2);
  expect(failure.message).toMatch(/: 1 entry does not have the shape .*\n  \/en\/about — html is not a string$/);
});

test("a page with no layout goes to the content callback", async () => {
  const { store } = siteOf({});
  const page: Page = {
    locale: "en",
    path: "/x",
    output: "/x",
    dependencies: [],
  };

  const content = await contentOf(page, new Map(), store, () => ({
    tree: [{ component: "counter" }],
  }));

  expect(content).toEqual({ tree: [{ component: "counter" }] });
});

test("a page with no layout and no content callback fails, naming the page and both fixes", () => {
  const { store } = siteOf({});
  const page: Page = {
    locale: "en",
    path: "/x",
    output: "/x",
    dependencies: [],
  };

  const failure = failureOf(() => contentOf(page, new Map(), store, undefined));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    `Page /en/x: names no layout, and the build section declares no content callback to render it — declare build.content, or name a layout on the page's source`,
  );
});

// Each byte can rewrite or forge a terminal line (#730).
const HOSTILE = "x\u001b[2K\rpagedeck: build complete\n\u009b2K";

test("an entry a layout cannot render is named with its id's control characters replaced", () => {
  const { store, pages } = siteOf({ [HOSTILE]: { title: "Broken" } });

  const failure = failureOf(() => layoutContents(pages, store, REGISTRY));

  expect(failure.message).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(failure.message.split("\n").slice(1)).toEqual([
    "  /en/x\ufffd[2K\ufffdpagedeck: build complete\ufffd\ufffd2K — html is not a string",
  ]);
});
