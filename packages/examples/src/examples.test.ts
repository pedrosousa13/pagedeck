import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { openStoreReadOnly } from "@pagedeck/content";
import type { ContentStoreReader, Entry } from "@pagedeck/content";
import type { BuildSection } from "@pagedeck/core";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { netlify } from "@pagedeck/adapter-netlify";
import { nginx } from "@pagedeck/adapter-nginx";
import { defineFixturePages } from "./defining-a-collection.js";
import { collectDefaultedPages, collectSitePages } from "./defining-pages.js";
import { syncHandWrittenLoader } from "./implementing-a-loader.js";
import { queryArticles } from "./querying-with-a-schema.js";
import { syncBrokenArticle } from "./a-broken-entry.js";
import { registerComponents } from "./registering-components.js";
import { renderExamplePage } from "./rendering-a-page.js";
import { islandNestedClientComponent } from "./islanding-a-nested-client-component.js";
import { planDeployFromManifests } from "./diffing-two-manifests.js";
import { renderSiteImages } from "./rendering-images.js";
import { compileEdgeArtifacts } from "./compiling-edge-artifacts.js";

const tempDirs: string[] = [];
const openStores: ContentStoreReader[] = [];

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-examples-"));
  tempDirs.push(dir);
  return join(dir, "content.db");
}

function track<T extends ContentStoreReader>(store: T): T {
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the collection example syncs the fixture site and ranks both page modes", async () => {
  const { store, sync, ranking } = await defineFixturePages(tempStorePath());
  track(store);

  expect(sync.changed).toEqual([
    { locale: "de", path: "home" },
    { locale: "de", path: "pricing" },
    { locale: "en", path: "home" },
    { locale: "en", path: "pricing" },
  ]);
  expect(sync.cursor).toBe(4);

  const byComponent = new Map(ranking.map((row) => [row.component, row]));
  expect(byComponent.get("Hero")?.storyCount).toBe(2);
  expect(byComponent.get("PricingTable")?.storyCount).toBe(2);
  expect(byComponent.get("FeatureCard")?.totalUsages).toBe(4);
});

test("the pages example routes a collection, a literal list and a template into one table", async () => {
  const { store, pages, introLink } = await collectSitePages(tempStorePath());
  track(store);

  const table = pages.map(
    (page) => `${page.locale} ${page.path} -> ${page.output}`,
  );
  expect(table).toEqual([
    "de / -> /de",
    "de /docs/v2/anleitung -> /de/docs/v2/anleitung",
    "de /legal/impressum -> /de/legal/impressum",
    "de /pricing -> /de/pricing",
    "en / -> /en",
    "en /docs/v2/guide/intro -> /en/docs/v2/guide/intro",
    "en /legal/privacy%2Fcookies -> /en/legal/privacy%2Fcookies",
    "en /legal/terms -> /en/legal/terms",
    "en /pricing -> /en/pricing",
  ]);

  const pricing = pages.find(
    (page) => page.locale === "en" && page.path === "/pricing",
  );
  expect(pricing?.collection).toBe("pages");
  expect(pricing?.entry).toEqual({ locale: "en", path: "pricing" });
  expect(pricing?.template).toBe("PricingPage");
  expect(pricing?.dependencies).toEqual([
    { collection: "pages", locale: "en", path: "pricing" },
    { collection: "pages", locale: "en", path: "nav" },
  ]);

  const home = pages.find((page) => page.locale === "en" && page.path === "/");
  expect(home?.dependencies).toEqual([
    { collection: "pages", locale: "en", path: "home" },
    { collection: "pages", locale: "en", path: "nav" },
  ]);
  expect(home?.relations).toEqual([
    { collection: "pages", locale: "en", path: "pricing" },
  ]);
  expect(pricing?.relations).toEqual([]);

  const terms = pages.find(
    (page) => page.locale === "en" && page.path === "/legal/terms",
  );
  expect(terms?.collection).toBeUndefined();
  expect(terms?.entry).toBeUndefined();
  expect(terms?.dependencies).toEqual([]);
  expect(terms?.relations).toBeUndefined();

  // Held against the emitted row, not a literal, so the two cannot drift together.
  const intro = pages.find(
    (page) => page.locale === "en" && page.path === "/docs/v2/guide/intro",
  );
  expect(introLink).toBe(intro?.output);
});

test("the defaults example routes index entries at their directories, in one en locale", async () => {
  const { store, pages } = await collectDefaultedPages(tempStorePath());
  track(store);

  expect(
    pages.map((page) => `${page.locale} ${page.path} -> ${page.output}`),
  ).toEqual(["en / -> /", "en /about/ -> /about/", "en /docs/ -> /docs/"]);
});

test("the loader example applies a full sync, then only the delta", async () => {
  const { store, full, incremental, notes } =
    await syncHandWrittenLoader(tempStorePath());
  track(store);

  expect(full.changed).toEqual([
    { locale: "en", path: "first" },
    { locale: "en", path: "second" },
    { locale: "en", path: "third" },
  ]);
  expect(full.cursor).toBe(2);

  expect(incremental.changed).toEqual([{ locale: "en", path: "second" }]);
  expect(incremental.deleted).toEqual([{ locale: "en", path: "first" }]);
  expect(incremental.cursor).toBe(4);

  expect(notes).toEqual([
    { title: "Second note, revised" },
    { title: "Third note" },
  ]);
});

test("the query example returns entries typed by the collection's schema", async () => {
  const { store, welcome, all, due } = await queryArticles(tempStorePath());
  track(store);

  expectTypeOf(welcome).toEqualTypeOf<
    Entry<{ title: string; publishAt: string }> | undefined
  >();
  expect(welcome?.data.title).toBe("Welcome");

  expect(all.map((entry) => `${entry.locale}/${entry.path}`)).toEqual([
    "de/willkommen",
    "en/roadmap",
    "en/welcome",
  ]);
  expect(due.map((entry) => `${entry.locale}/${entry.path}`)).toEqual([
    "de/willkommen",
    "en/welcome",
  ]);
});

test("the broken example fails with a message naming the entry and the field", async () => {
  const storePath = tempStorePath();

  await expect(syncBrokenArticle(storePath)).rejects.toThrowError(
    new Error(
      `Collection "articles": 1 entry does not match the collection schema — fix the content, or relax the schema:
  /en/no-title: title — Invalid input: expected string, received undefined`,
    ),
  );

  const store = track(openStoreReadOnly(storePath));
  expect(store.listEntries("articles")).toEqual([]);
});

test("the registry example merges two registries and resolves hydration per component", () => {
  const { hero, modes, unregistered, warnings } = registerComponents();

  expect(warnings).toEqual([
    'Component "hero": registered by two merged registries — the later one wins and the earlier one is unreachable; rename one of them, or drop the merge',
  ]);

  expect(hero).toBe("./components/site_hero.tsx");

  expect(modes).toEqual({
    hero: { mode: "none", source: "defaulted" },
    carousel: { mode: "idle", source: "declared" },
    lead_form: { mode: "visible", source: "defaulted" },
    map_widget: { mode: "load", source: "declared" },
  });

  expect(unregistered).toBe(
    'Component "testimonials": not registered, and entry /en/home references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
  );
});

test("the render example escapes content, keeps rich text raw, and refuses build-time IO", async () => {
  const { html, templateHtml, islands, fetchDuringRender } =
    await renderExamplePage();
  const [tabs, addToCart] = islands;

  expect(islands.map((island) => [island.component, island.path])).toEqual([
    ["Tabs", [3]],
    ["AddToCart", [3, 0]],
  ]);

  expect(html).toBe(
    '<div data-theme="dark">' +
      '<section class="hero" lang="en" dir="ltr"><h1>Ship faster</h1>' +
      '<p class="tagline">&lt;script&gt;alert(1)&lt;/script&gt;</p>' +
      "</section>" +
      '<div class="prose"><p>Read the <em>docs</em>.</p></div>' +
      '<p class="stats">4 pages</p>' +
      // Spelled out, not assembled from the build's constants: it is a wire format.
      `<fw-island data-fw-prefix="${tabs?.prefix ?? ""}"` +
      ` data-fw-component="Tabs" data-fw-mode="visible"` +
      ` data-fw-props="{&quot;open&quot;:0}"` +
      ` role="presentation" style="display:contents">${tabs?.html ?? ""}</fw-island>` +
      "</div>",
  );

  expect(templateHtml).toBe(
    '<div data-theme="dark"><div class="pricing"><h1>Pricing</h1>' +
      '<table class="plans"><tbody>' +
      "<tr><td>Starter</td><td>€0</td></tr>" +
      "<tr><td>Team</td><td>€49</td></tr>" +
      "</tbody></table>" +
      '<dl class="faq"></dl></div></div>',
  );

  expect(html).not.toContain("<script");

  expect(tabs?.prefix).toBe("iafb097ba72a9");
  expect(tabs?.mode).toBe("visible");
  expect(tabs?.html).toBe(
    '<div data-theme="dark"><div class="tabs">' +
      '<fw-slot data-fw-slot="3.0" role="presentation" style="display:contents">' +
      '<div data-theme="dark">' +
      `<fw-island data-fw-prefix="${addToCart?.prefix ?? ""}"` +
      ` data-fw-component="AddToCart" data-fw-mode="visible"` +
      ` data-fw-props="{&quot;sku&quot;:&quot;fw-tee&quot;}"` +
      ` role="presentation" style="display:contents">${addToCart?.html ?? ""}</fw-island>` +
      "</div>" +
      "</fw-slot>" +
      "</div></div>" +
      '<template data-fw-template="3.1">' +
      '&lt;div data-theme="dark">&lt;p class="tagline">Ships in two days&lt;/p>&lt;/div>' +
      "</template>",
  );

  expect(addToCart?.prefix).toBe("i359f2c43e01d");
  expect(addToCart?.prefix).not.toBe(tabs?.prefix);
  expect(addToCart?.html).toBe(
    '<div data-theme="dark">' +
      `<button class="add" id="_${addToCart?.prefix ?? ""}R_0_" type="button" name="fw-tee">` +
      "Add to cart" +
      "</button></div>",
  );

  expect(fetchDuringRender).toBe(
    'Component "Weather": suspended on data the framework did not resolve, while rendering entry /en/home — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection\'s loader and read it with useBuildData()',
  );
});

test("the client-reference example islands a component no entry names", async () => {
  const { html, islands, refusedChildren } =
    await islandNestedClientComponent();
  const [like] = islands;

  expect(islands).toHaveLength(1);
  expect(like?.component).toBe("LikeButton");
  expect(like?.mode).toBe("visible");
  expect(like?.path).toBeUndefined();

  expect(html).toBe(
    '<div data-theme="dark"><footer class="article"><h2>Ship faster</h2>' +
      `<fw-island data-fw-prefix="${like?.prefix ?? ""}"` +
      ` data-fw-component="LikeButton" data-fw-mode="visible"` +
      ` data-fw-props="{&quot;count&quot;:12}"` +
      ` role="presentation" style="display:contents">` +
      '<div data-theme="dark">' +
      `<button class="like" id="_${like?.prefix ?? ""}R_0_" type="button">12 likes</button>` +
      "</div>" +
      "</fw-island>" +
      "</footer></div>",
  );

  expect(refusedChildren).toBe(
    'Component "Tabs": is given JSX children, and "BadFooter" renders it in entry /en/article — a client component\'s children are slots, and a slot is identified by its position in the entry tree, which a component\'s own JSX has none of — place the component as a node in the entry tree, where its children become slots, or move "use client" down to the interactive leaves so the wrapper stays a server component',
  );
});

test("the diff example plans a deploy that uploads assets before HTML", () => {
  const { diff, steps, cleanup } = planDeployFromManifests();

  expect(steps).toEqual([
    "default: put /assets/app-d4e5f6.js (added)",
    "default: put /index.html (changed)",
  ]);
  expect(diff.stats).toEqual({
    added: 1,
    changed: 1,
    pruned: 1,
    unchanged: 1,
    uploadBytes: 15 + 43,
    prunedBytes: 15,
  });

  expect(cleanup.keys).toEqual(["/assets/app-a1b2c3.js"]);
  expect(cleanup.notBefore).toBe("2026-09-02T09:30:00.000Z");
});

test("the image example renders a responsive img and refuses an unmeasured asset", async () => {
  const { html, url, missingDimensions } = await renderSiteImages();

  expect(url).toBe("https://images.example/uploads/hero.jpg?w=640&fm=auto");

  // `fetchPriority` keeps React's camel case; HTML attribute names are case-insensitive.
  expect(html).toBe(
    // React DOM's own preload for an `<img>` that is not lazy.
    '<link rel="preload" as="image" ' +
      'imageSrcSet="https://images.example/uploads/hero.jpg?w=320&amp;q=70&amp;fm=auto 320w, ' +
      "https://images.example/uploads/hero.jpg?w=640&amp;q=70&amp;fm=auto 640w, " +
      'https://images.example/uploads/hero.jpg?w=1280&amp;q=70&amp;fm=auto 1280w" ' +
      'imageSizes="(min-width: 60rem) 50vw, 100vw" fetchPriority="high"/>' +
      '<img alt="The team, mid-deploy" ' +
      'src="https://images.example/uploads/hero.jpg?w=1280&amp;q=70&amp;fm=auto" ' +
      'srcSet="https://images.example/uploads/hero.jpg?w=320&amp;q=70&amp;fm=auto 320w, ' +
      "https://images.example/uploads/hero.jpg?w=640&amp;q=70&amp;fm=auto 640w, " +
      'https://images.example/uploads/hero.jpg?w=1280&amp;q=70&amp;fm=auto 1280w" ' +
      'sizes="(min-width: 60rem) 50vw, 100vw" width="2400" height="1350" ' +
      'loading="eager" fetchPriority="high" style="background-color:#2f3a28"/>' +
      '<img alt="A pricing table" ' +
      'src="https://images.example/uploads/pricing.png?w=640&amp;q=70&amp;fm=auto" ' +
      'srcSet="https://images.example/uploads/pricing.png?w=320&amp;q=70&amp;fm=auto 320w, ' +
      'https://images.example/uploads/pricing.png?w=640&amp;q=70&amp;fm=auto 640w" ' +
      'sizes="320px" width="800" height="600" loading="lazy" fetchPriority="auto"/>',
  );

  expect(missingDimensions).toBe(
    'Entry /en/home: image "/uploads/unmeasured.jpg" declares 2 intrinsic dimensions that are not pixel sizes, so the browser reserves no space for it and the page shifts as it loads — pass the asset\'s own pixel width and height:\n' +
      "  width — undefined — not a number\n" +
      "  height — undefined — not a number",
  );
});

test("the edge example compiles a routing document into one host's artifacts, called directly", () => {
  const { routing, artifacts } = compileEdgeArtifacts();

  expect(routing.trees).toHaveLength(1);
  expect(artifacts).toEqual([
    {
      role: "tree-file",
      path: "/_redirects",
      contents: expect.stringContaining("404!"),
    },
  ]);
});

// `build.adapter` is core's own structural type (docs/adr/0009); each adapter
// package's factory return value must be assignable to it with no cast, so a
// site's config typechecks with no import from `@pagedeck/edge` at all.
test("every adapter package's factory satisfies build.adapter's type", () => {
  expectTypeOf(netlify()).toExtend<NonNullable<BuildSection["adapter"]>>();
  expectTypeOf(nginx()).toExtend<NonNullable<BuildSection["adapter"]>>();
  expectTypeOf(cloudfront()).toExtend<NonNullable<BuildSection["adapter"]>>();
  expectTypeOf(cloudflareWorker()).toExtend<NonNullable<BuildSection["adapter"]>>();
});
