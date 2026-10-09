import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { EntryPlan, PageDemand } from "./entries.js";
import { planEntries } from "./entries.js";
import { mergeDemands, pageKey, planIncremental } from "./incremental.js";
import type { BuildDelta } from "./incremental.js";
import { buildManifest, fileKey } from "./manifest.js";
import type { EmittedFile, Manifest, ManifestFile } from "./manifest.js";
import type { EntryRef, Page } from "./pages.js";
import { planTiers } from "./tiers.js";
import type { TierPlan } from "./tiers.js";
import { planRouting } from "./routing.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-incremental-build-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const FIXTURE: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-51c8"; }\n`,
  "Nav.js": `export default function Nav() { return "marker-nav-4d20"; }\n`,
  "Chart.js": `export default function Chart() { return "marker-chart-7b93"; }\n`,
};

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  for (const [file, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${file}`, source);
  }
  writeFileSync(ORIGIN, "export default {};\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

const MODULES = {
  Hero: "./src/Hero.js",
  Nav: "./src/Nav.js",
  Chart: "./src/Chart.js",
};

const SETTINGS: EntryRef = {
  collection: "globals",
  locale: "en",
  path: "settings",
};

function page(path: `/${string}`, output: string, entry: string): Page {
  return {
    locale: "en",
    path,
    output,
    collection: "pages",
    entry: { locale: "en", path: entry },
    dependencies: [{ collection: "pages", locale: "en", path: entry }, SETTINGS],
  };
}

const PAGES: readonly Page[] = [
  page("/", "/en", "home"),
  page("/about", "/en/about", "about"),
  page("/blog", "/en/blog", "blog"),
  page("/docs", "/en/docs", "docs"),
  page("/pricing", "/en/pricing", "pricing"),
];

// `Nav` and `Chart` on two of four entry pages each: both sit in the mid tier on page
// share, so `DRIFTED_RANKING` can move bytes and the pinning assertions can fail.
const ISLANDS: Record<string, readonly string[]> = {
  "en /": ["Hero", "Nav"],
  "en /about": [],
  "en /blog": ["Hero", "Chart"],
  "en /docs": ["Hero", "Chart"],
  "en /pricing": ["Hero", "Nav"],
};

function renderedDemand(page: Page, components: readonly string[]): PageDemand {
  return {
    page,
    islands: components.map((component) => ({
      component,
      mode: "load" as const,
    })),
  };
}

function html(page: Page, revision: string): EmittedFile {
  return {
    path: `${page.output}/index.html`,
    kind: "html",
    page: { locale: page.locale, path: page.path },
    contents: `<!doctype html><title>${page.locale} ${page.path}</title><p>${revision}</p>`,
  };
}

function className(component: string): string {
  return `fw-${component.toLowerCase()}`;
}

function stylesheets(
  entries: EntryPlan,
  classes: readonly string[],
): EmittedFile[] {
  const rule = (one: string): string => `.${one}{--fw-marker:1}`;
  return [
    {
      path: "/assets/core.css",
      kind: "css",
      contents: classes.map(rule).join("\n"),
    },
    ...[
      ...new Map(entries.entries.map((entry) => [entry.name, entry])).values(),
    ].map((entry) => ({
      path: `/assets/${entry.name}.css`,
      kind: "css" as const,
      contents: entry.components
        .map((component) => rule(className(component.name)))
        .join("\n"),
    })),
  ];
}

function classesOf(entries: EntryPlan): string[] {
  const classes = new Set(
    entries.entries.flatMap((entry) =>
      entry.components.map((component) => className(component.name)),
    ),
  );
  return [...classes].sort();
}

const DRIFTED_RANKING = [
  {
    component: "Chart",
    totalUsages: 999,
    storyCount: 9,
    avgPerStory: 111,
    avgFoldScore: 0.5,
  },
];

function reranked(demands: readonly PageDemand[]): TierPlan {
  return planTiers({
    entries: planEntries(demands, { modules: MODULES }).entries,
    ranking: DRIFTED_RANKING,
    policy: { minSize: 0 },
  });
}

interface Built {
  manifest: Manifest;
  demands: readonly PageDemand[];
}

async function fullBuild(): Promise<Built> {
  const demands = PAGES.map((one) =>
    renderedDemand(one, ISLANDS[pageKey(one)] ?? []),
  );
  const plan = planEntries(demands, { modules: MODULES });
  const tiers = planTiers({
    entries: plan.entries,
    ranking: [],
    policy: { minSize: 0 },
  });
  const built = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers,
  });

  const classes = classesOf(plan);

  return {
    demands,
    manifest: buildManifest({
      build: { id: "full", createdAt: "2026-08-25T10:00:00.000Z" },
      store: { seq: 100 },
      site: { trailingSlash: "never" },
      routing: planRouting({ pages: PAGES, trailingSlash: "never" }),
      pages: PAGES,
      entries: plan,
      tiers,
      classes,
      foldTuning: new Map(),
      outputs: [
        ...built.files,
        ...stylesheets(plan, classes),
        ...PAGES.map((one) => html(one, "first")),
      ],
    }),
  };
}

async function incrementalBuild(
  previous: Manifest,
  delta: BuildDelta,
  islandsOf: Record<string, readonly string[]> = ISLANDS,
  unpinned: { tiers?: TierPlan; classes?: readonly string[] } = {},
): Promise<Manifest> {
  const plan = planIncremental({ previous, pages: PAGES, delta });

  const rendered = plan.render.map((affected) =>
    renderedDemand(affected.page, islandsOf[pageKey(affected.page)] ?? []),
  );

  const entries = planEntries(mergeDemands(plan.demands, rendered), {
    modules: MODULES,
  });
  const tiers = unpinned.tiers ?? plan.pinned.tiers;
  const classes = unpinned.classes ?? plan.pinned.classes;
  const built = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    tiers,
  });

  return buildManifest({
    build: { id: "incremental", createdAt: "2026-08-25T11:00:00.000Z" },
    store: { seq: delta.head },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: PAGES, trailingSlash: "never" }),
    pages: PAGES,
    entries,
    tiers,
    classes,
    // Carried by the plan: `new Map()` here would write `[]` on every reused row (#24).
    foldTuning: plan.pinned.foldTuning,
    outputs: [
      ...built.files,
      ...stylesheets(entries, classes),
      ...plan.render.map((affected) => html(affected.page, "second")),
      ...plan.reuse.map((one) => html(one.page, "first")),
    ],
  });
}

function delta(changed: readonly EntryRef[], head = 101): BuildDelta {
  return { since: 100, head, changed, vanished: [], requested: [] };
}

function hashes(
  manifest: Manifest,
  kind: ManifestFile["kind"],
): Record<string, string> {
  return Object.fromEntries(
    manifest.files
      .filter((file) => file.kind === kind)
      .map((file) => [fileKey(file.domain, file.path), file.hash]),
  );
}

function entryChunks(manifest: Manifest): Record<string, string | undefined> {
  return Object.fromEntries(
    manifest.pages.map((one) => [pageKey(one), one.entryChunk]),
  );
}

test("a content edit re-renders its own page and leaves every JS file byte-identical", async () => {
  const full = await fullBuild();
  const next = await incrementalBuild(
    full.manifest,
    delta([{ collection: "pages", locale: "en", path: "blog" }]),
  );

  const before = hashes(full.manifest, "html");
  const after = hashes(next, "html");
  expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(
    Object.keys(after).filter((key) => after[key] !== before[key]),
  ).toEqual(["/en/blog/index.html"]);

  expect(Object.keys(hashes(full.manifest, "js")).length).toBeGreaterThan(2);
  expect(hashes(next, "js")).toEqual(hashes(full.manifest, "js"));
  expect(entryChunks(next)).toEqual(entryChunks(full.manifest));
  expect(Object.keys(hashes(full.manifest, "css")).length).toBeGreaterThan(2);
  expect(hashes(next, "css")).toEqual(hashes(full.manifest, "css"));
  expect(next.store).toEqual({ seq: 101 });
}, 60_000);

test("a global edit re-renders every page and still churns no JS", async () => {
  const full = await fullBuild();
  const next = await incrementalBuild(full.manifest, delta([SETTINGS]));

  const before = hashes(full.manifest, "html");
  const after = hashes(next, "html");
  expect(
    Object.keys(after).filter((key) => after[key] !== before[key]).sort(),
  ).toEqual([
    "/en/about/index.html",
    "/en/blog/index.html",
    "/en/docs/index.html",
    "/en/index.html",
    "/en/pricing/index.html",
  ]);
  expect(hashes(next, "js")).toEqual(hashes(full.manifest, "js"));
  expect(hashes(next, "css")).toEqual(hashes(full.manifest, "css"));
}, 60_000);

test("a content edit reuses the previous manifest's tiers and classes, and re-deriving them would move bytes", async () => {
  const full = await fullBuild();
  const edit = delta([{ collection: "pages", locale: "en", path: "blog" }]);
  const plan = planIncremental({
    previous: full.manifest,
    pages: PAGES,
    delta: edit,
  });

  expect(plan.pinned.tiers).toEqual(full.manifest.tiers);
  expect(plan.pinned.classes).toEqual(full.manifest.classes);

  const pinned = await incrementalBuild(full.manifest, edit);
  expect(hashes(pinned, "js")).toEqual(hashes(full.manifest, "js"));
  expect(hashes(pinned, "css")).toEqual(hashes(full.manifest, "css"));

  const drifted = reranked(full.demands);
  expect(drifted).not.toEqual(full.manifest.tiers);
  const rederived = await incrementalBuild(full.manifest, edit, ISLANDS, {
    tiers: drifted,
    classes: ["fw-hero", "fw-chart"],
  });
  expect(hashes(rederived, "js")).not.toEqual(hashes(full.manifest, "js"));
  expect(hashes(rederived, "css")).not.toEqual(hashes(full.manifest, "css"));
}, 60_000);

test("a page whose island set diverged rebuilds its own entry and nothing else", async () => {
  const full = await fullBuild();
  const next = await incrementalBuild(
    full.manifest,
    delta([{ collection: "pages", locale: "en", path: "blog" }]),
    { ...ISLANDS, "en /blog": ["Hero", "Chart", "Nav"] },
  );

  const before = hashes(full.manifest, "js");
  const after = hashes(next, "js");
  const wasBlog = full.manifest.pages.find((one) => one.path === "/blog");
  const isBlog = next.pages.find((one) => one.path === "/blog");

  expect(isBlog?.entryChunk).not.toBe(wasBlog?.entryChunk);
  expect(Object.keys(before).filter((key) => !(key in after))).toEqual([]);
  expect(Object.keys(after).filter((key) => !(key in before))).toEqual([
    isBlog?.entryChunk,
  ]);
  expect(next.pages.find((one) => one.path === "/docs")?.entryChunk).toBe(
    wasBlog?.entryChunk,
  );

  for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);

  const pinned = entryChunks(full.manifest);
  const now = entryChunks(next);
  for (const key of Object.keys(pinned)) {
    if (key === "en /blog") continue;
    expect(now[key]).toBe(pinned[key]);
  }
}, 60_000);
