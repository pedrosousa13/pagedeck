import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import { buildManifest, fileKey } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";
import { planRouting } from "./routing.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-manifest-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const FIXTURE: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-6d13"; }\n`,
  "Nav.js": `export default function Nav() { return "marker-nav-8a05"; }\n`,
  "Chart.js": `export default function Chart() { return "marker-chart-3e77"; }\n`,
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

const PAGES: readonly Page[] = [
  {
    locale: "de",
    path: "/",
    domain: "de.example",
    output: "/",
    dependencies: [],
  },
  { locale: "en", path: "/", output: "/en", dependencies: [] },
  { locale: "en", path: "/about", output: "/en/about", dependencies: [] },
  { locale: "en", path: "/blog", output: "/en/blog", dependencies: [] },
];

const ISLANDS: Record<string, readonly string[]> = {
  "de /": ["Hero", "Nav"],
  "en /": ["Hero", "Nav"],
  "en /about": [],
  "en /blog": ["Hero", "Chart"],
};

function demands(): readonly PageDemand[] {
  return PAGES.map((page) => ({
    page,
    islands: (ISLANDS[`${page.locale} ${page.path}`] ?? []).map(
      (component) => ({ component, mode: "load" as const }),
    ),
  }));
}

test("a full build yields a manifest covering every emitted file", async () => {
  const plan = planEntries(demands(), { modules: MODULES });
  const tiers = planTiers({
    entries: plan.entries,
    ranking: [],
    // `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
    // line each.
    policy: { minSize: 0 },
  });

  const built = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers,
  });
  expect(built.files.length).toBeGreaterThan(plan.entries.length);

  // Shared chunks stay in the default tree only. A real build copies them into every
  // tree (`placeClientFiles`); this fixture is about the manifest's joins.
  const domainOfPage = new Map(
    PAGES.map((page) => [`${page.locale} ${page.path}`, page.domain]),
  );
  const treesOfChunk = new Map<string, Set<string | undefined>>();
  for (const entry of plan.entries) {
    const path = built.entryScripts.get(entry.name);
    if (path === undefined) continue;
    const trees = treesOfChunk.get(path) ?? new Set<string | undefined>();
    trees.add(domainOfPage.get(`${entry.locale} ${entry.path}`));
    treesOfChunk.set(path, trees);
  }
  const emitted: EmittedFile[] = [
    ...built.files.flatMap((file) =>
      [...(treesOfChunk.get(file.path) ?? [undefined])].map((domain) =>
        domain === undefined ? file : { ...file, domain },
      ),
    ),
    ...PAGES.map((page) => ({
      ...(page.domain === undefined ? {} : { domain: page.domain }),
      path: `${page.output === "/" ? "" : page.output}/index.html`,
      kind: "html" as const,
      page: { locale: page.locale, path: page.path },
      contents: `<!doctype html><title>${page.locale} ${page.path}</title>`,
    })),
  ];

  const manifest = buildManifest({
    build: { id: "b1", createdAt: "2026-08-25T10:00:00.000Z" },
    store: { seq: 0 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: PAGES, trailingSlash: "never" }),
    pages: PAGES,
    entries: plan,
    tiers,
    classes: [],
    foldTuning: new Map(),
    outputs: emitted,
  });

  expect(manifest.files.length).toBe(emitted.length);
  expect(
    manifest.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.hash)),
  ).toBe(true);

  const keys = new Set(
    manifest.files.map((file) => fileKey(file.domain, file.path)),
  );
  for (const page of manifest.pages) {
    expect(keys.has(page.html)).toBe(true);
    if (page.entryChunk !== undefined)
      expect(keys.has(page.entryChunk)).toBe(true);
  }
  expect(
    manifest.pages
      .filter((page) => page.entryChunk !== undefined)
      .map((page) => `${page.locale} ${page.path}`),
  ).toEqual(["de /", "en /", "en /blog"]);

  const core = built.files.find((file) => file.name === "fw-core");
  expect(core?.contents).toContain("marker-hero-6d13");
  expect(
    manifest.tiers.assignments.find((one) => one.component === "Hero")?.group,
  ).toBe("fw-core");
}, 60_000);
