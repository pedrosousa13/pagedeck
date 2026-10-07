import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { openStore } from "@pagedeck/content";
import type { PageDemand } from "./entries.js";
import {
  crossPageAffected,
  mergeDemands,
  pageKey,
  planIncremental,
  publicationChanges,
  readDelta,
} from "./incremental.js";
import type { ScheduledCollection } from "./incremental.js";
import { MANIFEST_VERSION } from "./manifest.js";
import type { Manifest, ManifestPage } from "./manifest.js";
import type { EntryRef, Page } from "./pages.js";
import { planRouting } from "./routing.js";
import { planTiers } from "./tiers.js";

const NAV: EntryRef = { collection: "globals", locale: "en", path: "nav" };
const TESTIMONIAL: EntryRef = {
  collection: "blocks",
  locale: "en",
  path: "testimonial",
};

function page(
  path: `/${string}`,
  output: string,
  entry: string | undefined,
  dependencies: readonly EntryRef[],
): Page {
  return {
    locale: "en",
    path,
    output,
    ...(entry === undefined
      ? {}
      : { collection: "pages", entry: { locale: "en", path: entry } }),
    dependencies,
  };
}

const HOME = page("/", "/en", "home", [
  { collection: "pages", locale: "en", path: "home" },
  NAV,
]);
const PRICING = page("/pricing", "/en/pricing", "pricing", [
  { collection: "pages", locale: "en", path: "pricing" },
  NAV,
  TESTIMONIAL,
]);
const ABOUT = page("/about", "/en/about", "about", [
  { collection: "pages", locale: "en", path: "about" },
  NAV,
]);
const PAGES: readonly Page[] = [HOME, PRICING, ABOUT];

const RETIRED: ManifestPage = {
  locale: "en",
  path: "/pricing/legacy",
  output: "/en/pricing/legacy",
  collection: "pages",
  entry: { locale: "en", path: "legacy" },
  dependencies: [{ collection: "pages", locale: "en", path: "legacy" }],
  html: "/en/pricing/legacy/index.html",
  components: [{ name: "Hero", module: "@ds/Hero", eager: false }],
  entryChunk: "/assets/en-pricing-legacy-9f9f9f.js",
  foldTuning: [],
};

function row(source: Page, components: readonly string[]): ManifestPage {
  return {
    locale: source.locale,
    path: source.path,
    ...(source.domain === undefined ? {} : { domain: source.domain }),
    output: source.output,
    ...(source.collection === undefined
      ? {}
      : { collection: source.collection }),
    ...(source.entry === undefined ? {} : { entry: source.entry }),
    dependencies: source.dependencies,
    html: `${source.output}/index.html`,
    components: components.map((name) => ({
      name,
      module: `@ds/${name}`,
      eager: name === "Nav",
    })),
    ...(components.length === 0
      ? {}
      : { entryChunk: `/assets/${source.path}-abc123.js` }),
    foldTuning: [
      {
        component: "Hero",
        position: 0,
        from: "visible" as const,
        to: "load" as const,
      },
    ],
  };
}

function manifest(pages: readonly ManifestPage[], seq = 40): Manifest {
  return {
    version: MANIFEST_VERSION,
    build: { id: "build-1", createdAt: "2026-08-25T10:00:00.000Z" },
    store: { seq },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [], trailingSlash: "never" }),
    files: [],
    pages,
    tiers: planTiers({ entries: [], ranking: [] }),
    classes: [],
  };
}

const PREVIOUS = manifest([
  row(HOME, ["Hero", "Nav"]),
  row(PRICING, ["Hero"]),
  row(ABOUT, []),
  RETIRED,
]);

function delta(overrides: {
  changed?: readonly EntryRef[];
  vanished?: readonly EntryRef[];
  requested?: readonly EntryRef[];
  head?: number;
}) {
  return {
    since: 40,
    head: overrides.head ?? 41,
    changed: overrides.changed ?? [],
    vanished: overrides.vanished ?? [],
    requested: overrides.requested ?? [],
  };
}

function rendered(plan: { render: readonly { page: Page }[] }): string[] {
  return plan.render.map((affected) => pageKey(affected.page));
}

test("an edit to one entry re-renders exactly the pages that read it", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({
      changed: [{ collection: "pages", locale: "en", path: "pricing" }],
    }),
  });

  expect(rendered(plan)).toEqual(["en /pricing"]);
  expect(plan.render[0]?.reasons).toEqual([
    {
      kind: "own-entry",
      ref: { collection: "pages", locale: "en", path: "pricing" },
    },
  ]);
  expect(plan.reuse.map((one) => pageKey(one.page))).toEqual([
    "en /",
    "en /about",
  ]);
  expect(plan.stats).toEqual({
    total: 3,
    rendered: 1,
    reused: 2,
    removed: 1,
  });
});

test("a reused page's fold tuning is carried forward, and a re-rendered page's is not", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({
      changed: [{ collection: "pages", locale: "en", path: "pricing" }],
    }),
  });

  expect([...plan.pinned.foldTuning.keys()]).toEqual(["en /", "en /about"]);
  expect(plan.pinned.foldTuning.get("en /")).toEqual([
    { component: "Hero", position: 0, from: "visible", to: "load" },
  ]);
  expect(plan.pinned.foldTuning.get("en /pricing")).toBeUndefined();
});

test("an entry a page only references re-renders that page as a dependency", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({ changed: [TESTIMONIAL] }),
  });

  expect(rendered(plan)).toEqual(["en /pricing"]);
  expect(plan.render[0]?.reasons).toEqual([
    { kind: "dependency", ref: TESTIMONIAL },
  ]);
});

test("a global entry re-renders every page that reads it, with no special case", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({ changed: [NAV] }),
  });

  expect(rendered(plan)).toEqual(["en /", "en /pricing", "en /about"]);
  expect(plan.reuse).toEqual([]);
});

test("a dependency the store no longer holds re-renders the pages that read it", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({ vanished: [TESTIMONIAL] }),
  });

  expect(rendered(plan)).toEqual(["en /pricing"]);
  expect(plan.render[0]?.reasons).toEqual([
    { kind: "deleted-dependency", ref: TESTIMONIAL },
  ]);
});

test("a page whose output moved is rendered again, not reused against the old row", () => {
  const moved: Page = { ...ABOUT, output: "/en/about/" };

  const plan = planIncremental({
    previous: PREVIOUS,
    pages: [HOME, PRICING, moved],
    delta: delta({}),
  });

  expect(rendered(plan)).toEqual(["en /about"]);
  expect(plan.render[0]?.reasons).toEqual([
    { kind: "moved", from: { output: "/en/about" } },
  ]);
  expect(plan.stats).toEqual({ total: 3, rendered: 1, reused: 2, removed: 1 });
});

test("a page that moved to another tree is rendered again", () => {
  const moved: Page = { ...ABOUT, domain: "de.example" };

  const plan = planIncremental({
    previous: PREVIOUS,
    pages: [HOME, PRICING, moved],
    delta: delta({}),
  });

  expect(rendered(plan)).toEqual(["en /about"]);
  expect(plan.render[0]?.reasons).toEqual([
    { kind: "moved", from: { output: "/en/about" } },
  ]);
  expect(plan.reuse.map((one) => pageKey(one.page))).toEqual([
    "en /",
    "en /pricing",
  ]);
});

test("a page the previous manifest never held is rendered as new", () => {
  const plan = planIncremental({
    previous: manifest([row(HOME, ["Hero", "Nav"]), row(PRICING, ["Hero"])]),
    pages: PAGES,
    delta: delta({}),
  });

  expect(rendered(plan)).toEqual(["en /about"]);
  expect(plan.render[0]?.reasons).toEqual([{ kind: "new-page" }]);
});

test("a previous row that recorded no HTML is rendered again", () => {
  const plan = planIncremental({
    previous: manifest([
      row(HOME, ["Hero", "Nav"]),
      { ...row(PRICING, ["Hero"]), html: "" },
      row(ABOUT, []),
    ]),
    pages: PAGES,
    delta: delta({}),
  });

  expect(rendered(plan)).toEqual(["en /pricing"]);
  expect(plan.render[0]?.reasons).toEqual([{ kind: "no-previous-render" }]);
});

test("a page whose not-found status moved is rendered again, in both directions (#592)", () => {
  const became = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({}),
    notFound: (page) => page.path === "/about",
  });
  expect(rendered(became)).toEqual(["en /about"]);
  expect(became.render[0]?.reasons).toEqual([
    { kind: "not-found", noindex: true },
  ]);

  const stopped = planIncremental({
    previous: manifest([
      row(HOME, ["Hero", "Nav"]),
      row(PRICING, ["Hero"]),
      { ...row(ABOUT, []), noindex: true },
    ]),
    pages: PAGES,
    delta: delta({}),
  });
  expect(rendered(stopped)).toEqual(["en /about"]);
  expect(stopped.render[0]?.reasons).toEqual([
    { kind: "not-found", noindex: false },
  ]);
});

test("a not-found page that stays one is reused", () => {
  const plan = planIncremental({
    previous: manifest([
      row(HOME, ["Hero", "Nav"]),
      row(PRICING, ["Hero"]),
      { ...row(ABOUT, []), noindex: true },
    ]),
    pages: PAGES,
    delta: delta({}),
    notFound: (page) => page.path === "/about",
  });
  expect(rendered(plan)).toEqual([]);
});

test("a requested entry re-renders its pages without having changed", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({ requested: [NAV] }),
  });

  expect(rendered(plan)).toEqual(["en /", "en /pricing", "en /about"]);
  expect(plan.render[0]?.reasons).toEqual([{ kind: "requested", ref: NAV }]);
});

test("every reason a page has is reported, in one sorted order", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({
      changed: [
        NAV,
        { collection: "pages", locale: "en", path: "pricing" },
      ],
      vanished: [TESTIMONIAL],
    }),
  });

  expect(plan.render.find((one) => one.page.path === "/pricing")?.reasons)
    .toEqual([
      { kind: "deleted-dependency", ref: TESTIMONIAL },
      {
        kind: "dependency",
        ref: NAV,
      },
      {
        kind: "own-entry",
        ref: { collection: "pages", locale: "en", path: "pricing" },
      },
    ]);
});

test("a page the route table dropped is removed and redirected to its nearest live ancestor", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({}),
  });

  expect(plan.remove).toEqual([
    {
      page: { locale: "en", path: "/pricing/legacy" },
      html: "/en/pricing/legacy/index.html",
      entryChunk: "/assets/en-pricing-legacy-9f9f9f.js",
      entry: { collection: "pages", locale: "en", path: "legacy" },
    },
  ]);
  expect(plan.redirects).toEqual([
    {
      from: "/en/pricing/legacy",
      to: "/en/pricing",
      status: 308,
      reason: "deleted-page",
    },
  ]);
});

test("a redirect policy of none removes the page and points nowhere", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({}),
    redirect: { target: "none", status: 308 },
  });

  expect(plan.remove).toHaveLength(1);
  expect(plan.redirects).toEqual([]);
});

test("a removed page with no live ancestor in its tree is removed and not redirected", () => {
  const orphan: ManifestPage = {
    ...RETIRED,
    locale: "de",
    path: "/gone",
    domain: "de.example",
    output: "/gone",
    entry: { locale: "de", path: "legacy" },
    dependencies: [{ collection: "pages", locale: "de", path: "legacy" }],
    html: "//de.example/gone/index.html",
  };

  const plan = planIncremental({
    previous: manifest([row(HOME, []), row(PRICING, []), row(ABOUT, []), orphan]),
    pages: PAGES,
    delta: delta({}),
  });

  expect(plan.remove).toEqual([
    {
      page: { locale: "de", path: "/gone", domain: "de.example" },
      html: "//de.example/gone/index.html",
      entryChunk: RETIRED.entryChunk,
      entry: { collection: "pages", locale: "de", path: "legacy" },
    },
  ]);
  expect(plan.redirects).toEqual([]);
});

test("a reused page carries the components its previous build recorded", () => {
  const plan = planIncremental({
    previous: PREVIOUS,
    pages: PAGES,
    delta: delta({
      changed: [{ collection: "pages", locale: "en", path: "pricing" }],
    }),
  });

  expect(plan.demands).toEqual([
    {
      page: HOME,
      carried: [
        { name: "Hero", eager: false },
        { name: "Nav", eager: true },
      ],
    },
    { page: ABOUT, carried: [] },
  ]);
});

test("a rendered demand replaces the carried one for the same page", () => {
  const carried: readonly PageDemand[] = [
    { page: HOME, carried: [{ name: "Hero", eager: false }] },
    { page: ABOUT, carried: [] },
  ];
  const fresh: readonly PageDemand[] = [
    { page: PRICING, islands: [{ component: "Chart", mode: "visible" }] },
    { page: HOME, islands: [{ component: "Nav", mode: "load" }] },
  ];

  expect(mergeDemands(carried, fresh)).toEqual([
    { page: HOME, islands: [{ component: "Nav", mode: "load" }] },
    { page: ABOUT, carried: [] },
    { page: PRICING, islands: [{ component: "Chart", mode: "visible" }] },
  ]);
});

test("one entry every page depends on is planned in time linear in the pages", () => {
  // A wall clock: quadratic copying is invisible to any other observation (#60). The
  // ceiling is ~40x the linear cost and ~4x under the quadratic one.
  const SETTINGS: EntryRef = {
    collection: "globals",
    locale: "en",
    path: "settings",
  };
  const many: readonly Page[] = Array.from({ length: 40_000 }, (_, index) =>
    page(`/p${index}`, `/en/p${index}`, `p${index}`, [
      { collection: "pages", locale: "en", path: `p${index}` },
      SETTINGS,
    ]),
  );
  const previous = manifest(many.map((one) => row(one, [])));

  const started = performance.now();
  const plan = planIncremental({
    previous,
    pages: many,
    delta: delta({ changed: [SETTINGS] }),
  });
  const elapsed = performance.now() - started;

  expect(plan.stats).toEqual({
    total: 40_000,
    rendered: 40_000,
    reused: 0,
    removed: 0,
  });
  expect(elapsed).toBeLessThan(4_000);
}, 120_000);

const TEMP = mkdtempSync(join(tmpdir(), "pagedeck-incremental-"));

afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

test("the delta is read from the store's write sequence and the previous manifest", () => {
  const store = openStore(join(TEMP, "content.db"));
  try {
    store.upsertEntry({
      collection: "pages",
      locale: "en",
      path: "home",
      data: { title: "Home" },
    });
    store.upsertEntry({
      collection: "blocks",
      locale: "en",
      path: "testimonial",
      data: { quote: "one" },
    });
    const settled = store.getEntry("blocks", "en", "testimonial")?.seq ?? 0;

    store.upsertEntry({
      collection: "pages",
      locale: "en",
      path: "home",
      data: { title: "Home, edited" },
    });
    store.deleteEntry("blocks", "en", "testimonial");

    const read = readDelta(store, manifest(PREVIOUS.pages, settled));

    expect(read.since).toBe(settled);
    expect(read.head).toBeGreaterThan(settled);
    expect(read.changed).toEqual([
      { collection: "pages", locale: "en", path: "home" },
    ]);
    expect(read.vanished).toEqual([
      { collection: "blocks", locale: "en", path: "testimonial" },
      { collection: "globals", locale: "en", path: "nav" },
      { collection: "pages", locale: "en", path: "about" },
      { collection: "pages", locale: "en", path: "legacy" },
      { collection: "pages", locale: "en", path: "pricing" },
    ]);
    expect(read.requested).toEqual([]);
  } finally {
    store.close();
  }
});

test("a store with nothing written since the previous build yields an empty delta", () => {
  const store = openStore(join(TEMP, "quiet.db"));
  try {
    store.upsertEntry({
      collection: "pages",
      locale: "en",
      path: "home",
      data: { title: "Home" },
    });
    const head = store.getEntry("pages", "en", "home")?.seq ?? 0;

    const read = readDelta(store, manifest([row(HOME, [])], head));

    expect(read.changed).toEqual([]);
    expect(read.head).toBe(head);
  } finally {
    store.close();
  }
});

const LAST_BUILD = "2026-08-25T10:00:00.000Z";
const THIS_BUILD = "2026-08-25T14:00:00.000Z";

const ARTICLES: ScheduledCollection = {
  name: "articles",
  publishField: "publishAt",
  unpublishField: "unpublishAt",
};

const UNSCHEDULED: ScheduledCollection = { name: "pages" };

function scheduledStore(file: string) {
  const store = openStore(join(TEMP, file));
  const article = (path: string, data: Record<string, string>): void => {
    store.upsertEntry({ collection: "articles", locale: "en", path, data });
  };
  article("standing", { publishAt: "2026-08-01T00:00:00.000Z" });
  article("handover", { publishAt: LAST_BUILD });
  article("arriving", { publishAt: "2026-08-25T12:00:00.000Z" });
  article("queued", { publishAt: "2026-08-26T00:00:00.000Z" });
  article("retiring", {
    publishAt: "2026-08-01T00:00:00.000Z",
    unpublishAt: "2026-08-25T12:00:00.000Z",
  });
  article("gone", {
    publishAt: "2026-08-01T00:00:00.000Z",
    unpublishAt: LAST_BUILD,
  });
  article("expiring", {
    publishAt: "2026-08-01T00:00:00.000Z",
    unpublishAt: THIS_BUILD,
  });
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "home",
    data: { title: "Home" },
  });
  return store;
}

const LAST = manifest([row(HOME, [])]);

test("an entry that became due between the two builds is requested, and one already published before them is not", () => {
  const store = scheduledStore("publishing.db");
  try {
    const changes = publicationChanges(store, LAST, [ARTICLES], THIS_BUILD);

    expect(changes).toEqual([
      { collection: "articles", locale: "en", path: "arriving" },
      { collection: "articles", locale: "en", path: "expiring" },
      { collection: "articles", locale: "en", path: "retiring" },
    ]);
  } finally {
    store.close();
  }
});

test("an entry that became unpublished between the two builds is requested", () => {
  const store = scheduledStore("unpublishing.db");
  try {
    const changes = publicationChanges(
      store,
      LAST,
      [{ name: "articles", unpublishField: "unpublishAt" }],
      THIS_BUILD,
    );

    expect(changes).toEqual([
      { collection: "articles", locale: "en", path: "expiring" },
      { collection: "articles", locale: "en", path: "retiring" },
    ]);
  } finally {
    store.close();
  }
});

test("an entry due only after this build is not requested until the build it becomes due in", () => {
  const store = scheduledStore("later.db");
  try {
    const changes = publicationChanges(
      store,
      { ...LAST, build: { id: "build-1", createdAt: THIS_BUILD } },
      [ARTICLES],
      "2026-08-27T00:00:00.000Z",
    );

    expect(changes).toEqual([
      { collection: "articles", locale: "en", path: "queued" },
    ]);
  } finally {
    store.close();
  }
});

test("an entry unpublished at the previous build's own instant was already gone then, so the interval does not hold it", () => {
  const store = scheduledStore("unpublish-handover.db");
  try {
    const changes = publicationChanges(store, LAST, [ARTICLES], THIS_BUILD);

    expect(changes).not.toContainEqual({
      collection: "articles",
      locale: "en",
      path: "gone",
    });
    expect(changes).not.toContainEqual({
      collection: "articles",
      locale: "en",
      path: "handover",
    });
  } finally {
    store.close();
  }
});

test("an entry unpublished at this build's own instant is gone as of this build, so the interval holds it", () => {
  const store = scheduledStore("unpublish-now.db");
  try {
    const changes = publicationChanges(store, LAST, [ARTICLES], THIS_BUILD);

    expect(changes).toContainEqual({
      collection: "articles",
      locale: "en",
      path: "expiring",
    });
  } finally {
    store.close();
  }
});

test("a collection declaring no publication window contributes no request", () => {
  const store = scheduledStore("unscheduled.db");
  try {
    expect(publicationChanges(store, LAST, [UNSCHEDULED], THIS_BUILD)).toEqual(
      [],
    );
  } finally {
    store.close();
  }
});

test("the publication changes are what readDelta reports as requested", () => {
  const store = scheduledStore("requested.db");
  try {
    const head = store.getEntry("pages", "en", "home")?.seq ?? 0;
    const previous = manifest([row(HOME, [])], head);

    const read = readDelta(
      store,
      previous,
      publicationChanges(store, previous, [ARTICLES, UNSCHEDULED], THIS_BUILD),
    );

    expect(read.changed).toEqual([]);
    expect(read.requested).toEqual([
      { collection: "articles", locale: "en", path: "arriving" },
      { collection: "articles", locale: "en", path: "expiring" },
      { collection: "articles", locale: "en", path: "retiring" },
    ]);
  } finally {
    store.close();
  }
});

function localized(
  locale: string,
  path: `/${string}`,
  output: string,
  entry: string,
  relations: readonly EntryRef[] = [],
): Page {
  return {
    locale,
    path,
    output,
    collection: "pages",
    entry: { locale, path: entry },
    dependencies: [{ collection: "pages", locale, path: entry }],
    ...(relations.length === 0 ? {} : { relations }),
  };
}

const EN_HOME = localized("en", "/", "/en", "home");
const FR_HOME = localized("fr", "/", "/fr", "home");
const FR_NEW = localized("fr", "/new", "/fr/new", "new");
const EN_NEW = localized("en", "/new", "/en/new", "new");

function addedSibling() {
  return planIncremental({
    previous: manifest([
      row(EN_HOME, []),
      row(FR_HOME, []),
      row(FR_NEW, []),
    ]),
    pages: [EN_HOME, EN_NEW, FR_HOME, FR_NEW],
    delta: delta({
      changed: [{ collection: "pages", locale: "en", path: "new" }],
    }),
  });
}

test("a reused page whose path gained a locale is widened by the hreflang join", () => {
  const widened = crossPageAffected({
    plan: addedSibling(),
    alternates: true,
    speculation: false,
  });

  expect(widened.map((one) => pageKey(one.page))).toEqual(["fr /new"]);
  expect(widened[0]?.reasons).toEqual([
    { kind: "sibling-changed", page: { locale: "en", path: "/new" } },
  ]);
});

test("a reused page whose sibling only changed address is widened by the hreflang join", () => {
  const plan = planIncremental({
    previous: manifest([
      row(EN_HOME, []),
      row(FR_HOME, []),
      { ...row(EN_NEW, []), output: "/en/new/" },
      row(FR_NEW, []),
    ]),
    pages: [EN_HOME, EN_NEW, FR_HOME, FR_NEW],
    delta: delta({}),
  });

  expect(rendered(plan)).toEqual(["en /new"]);
  expect(plan.render[0]?.reasons).toEqual([
    { kind: "moved", from: { output: "/en/new/" } },
  ]);

  const widened = crossPageAffected({
    plan,
    alternates: true,
    speculation: false,
  });

  expect(widened.map((one) => pageKey(one.page))).toEqual(["fr /new"]);
  expect(widened[0]?.reasons).toEqual([
    { kind: "sibling-changed", page: { locale: "en", path: "/new" } },
  ]);
});

test("a reused page whose path group did not move is not widened", () => {
  const widened = crossPageAffected({
    plan: addedSibling(),
    alternates: true,
    speculation: false,
  });

  expect(widened.map((one) => pageKey(one.page))).not.toContain("en /");
  expect(widened.map((one) => pageKey(one.page))).not.toContain("fr /");
});

test("a site that declares no origin emits no hreflang, so nothing is widened for it", () => {
  expect(
    crossPageAffected({
      plan: addedSibling(),
      alternates: false,
      speculation: false,
    }),
  ).toEqual([]);
});

test("a reused page relating to a page that moved is widened by the speculation join", () => {
  const source = localized("en", "/blog", "/en/blog", "blog", [
    { collection: "pages", locale: "en", path: "target" },
  ]);
  const target = localized("en", "/target", "/en/target/", "target");
  const previous = manifest([
    row(source, []),
    { ...row(target, []), output: "/en/target" },
  ]);

  const widened = crossPageAffected({
    plan: planIncremental({ previous, pages: [source, target], delta: delta({}) }),
    alternates: false,
    speculation: true,
  });

  expect(widened.map((one) => pageKey(one.page))).toEqual(["en /blog"]);
  expect(widened[0]?.reasons).toEqual([
    { kind: "sibling-changed", page: { locale: "en", path: "/target" } },
  ]);
});

test("a site that declares no speculation setting emits no rules, so nothing is widened for it", () => {
  const source = localized("en", "/blog", "/en/blog", "blog", [
    { collection: "pages", locale: "en", path: "target" },
  ]);
  const target = localized("en", "/target", "/en/target/", "target");
  const previous = manifest([
    row(source, []),
    { ...row(target, []), output: "/en/target" },
  ]);

  expect(
    crossPageAffected({
      plan: planIncremental({
        previous,
        pages: [source, target],
        delta: delta({}),
      }),
      alternates: false,
      speculation: false,
    }),
  ).toEqual([]);
});

test("a reused page relating to nothing that moved is not widened", () => {
  const source = localized("en", "/blog", "/en/blog", "blog", [
    { collection: "pages", locale: "en", path: "other" },
  ]);
  const target = localized("en", "/target", "/en/target/", "target");
  const previous = manifest([
    row(source, []),
    { ...row(target, []), output: "/en/target" },
  ]);

  expect(
    crossPageAffected({
      plan: planIncremental({
        previous,
        pages: [source, target],
        delta: delta({}),
      }),
      alternates: false,
      speculation: true,
    }),
  ).toEqual([]);
});

test("a page the route table dropped widens the pages that related to it", () => {
  const source = localized("en", "/blog", "/en/blog", "blog", [
    { collection: "pages", locale: "en", path: "target" },
  ]);
  const target = localized("en", "/target", "/en/target", "target");

  const widened = crossPageAffected({
    plan: planIncremental({
      previous: manifest([row(source, []), row(target, [])]),
      pages: [source],
      delta: delta({
        vanished: [{ collection: "pages", locale: "en", path: "target" }],
      }),
    }),
    alternates: false,
    speculation: true,
  });

  expect(widened.map((one) => pageKey(one.page))).toEqual(["en /blog"]);
  expect(widened[0]?.reasons).toEqual([
    { kind: "sibling-changed", page: { locale: "en", path: "/target" } },
  ]);
});

test("a page the route table dropped widens the pages that shared its path", () => {
  const widened = crossPageAffected({
    plan: planIncremental({
      previous: manifest([row(EN_HOME, []), row(FR_HOME, []), row(FR_NEW, []), row(EN_NEW, [])]),
      pages: [EN_HOME, FR_HOME, FR_NEW],
      delta: delta({
        vanished: [{ collection: "pages", locale: "en", path: "new" }],
      }),
    }),
    alternates: true,
    speculation: false,
  });

  expect(widened.map((one) => pageKey(one.page))).toEqual(["fr /new"]);
});

test("a page that changed path is named by the path this build emits, not the one it dropped", () => {
  const source = localized("en", "/blog", "/en/blog", "blog", [
    { collection: "pages", locale: "en", path: "target" },
  ]);
  const before = localized("en", "/target", "/en/target", "target");
  const after = localized("en", "/moved", "/en/moved", "target");
  const plan = planIncremental({
    previous: manifest([row(source, []), row(before, [])]),
    pages: [source, after],
    delta: delta({}),
  });

  expect(plan.remove.map((one) => one.entry)).toEqual([
    { collection: "pages", locale: "en", path: "target" },
  ]);
  expect(rendered(plan)).toEqual(["en /moved"]);

  const widened = crossPageAffected({
    plan,
    alternates: false,
    speculation: true,
  });

  expect(widened[0]?.reasons).toEqual([
    { kind: "sibling-changed", page: { locale: "en", path: "/moved" } },
  ]);
});

test("a removed fallback copy carries no entry and widens nobody's relations", () => {
  const source = localized("en", "/blog", "/en/blog", "blog", [
    { collection: "pages", locale: "en", path: "target" },
  ]);
  const target = localized("en", "/target", "/en/target", "target");
  const filled: ManifestPage = {
    ...row(localized("fr", "/target", "/fr/target", "target"), []),
    entry: { locale: "en", path: "target" },
    fallbackFrom: "en",
  };
  const plan = planIncremental({
    previous: manifest([row(source, []), row(target, []), filled]),
    pages: [source, target],
    delta: delta({}),
  });

  expect(plan.remove).toEqual([
    {
      page: { locale: "fr", path: "/target" },
      html: "/fr/target/index.html",
    },
  ]);
  expect(
    crossPageAffected({ plan, alternates: false, speculation: true }),
  ).toEqual([]);
});
