import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { defineCollection, openStore } from "@pagedeck/content";
import type { Entry, Loader } from "@pagedeck/content";
import { defineConfig, loadConfig } from "./config.js";
import { ConfigError } from "./exit.js";
import { defineLocales } from "./locales.js";
import { collectPages, definePages, fromCollection } from "./pages.js";

const tempDirs: string[] = [];

function tempSiteDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CORE_CONFIG = join(import.meta.dirname, "config.ts");

function configSource(collectionName: string, store: string): string {
  return `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};

export default defineConfig({
  store: ${JSON.stringify(store)},
  collections: [
    {
      name: ${JSON.stringify(collectionName)},
      loader: {
        syncAll(writer) {
          writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
          return { changed: [{ locale: "en", path: "home" }], deleted: [], cursor: 1 };
        },
        syncSince() {
          return { changed: [], deleted: [], cursor: 1 };
        },
      },
      schema: false,
    },
  ],
});
`;
}

function writeConfig(dir: string, filename: string, source: string): void {
  writeFileSync(join(dir, filename), source);
}

test("loadConfig reads pagedeck.config.ts and resolves the store path against the config file", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", configSource("pages", "./content/site.db"));

  const config = await loadConfig(dir);

  expect(config.configPath).toBe(join(dir, "pagedeck.config.ts"));
  expect(config.storePath).toBe(join(dir, "content", "site.db"));
  expect(config.collections.map((c) => c.name)).toEqual(["pages"]);
});

test("loadConfig falls back to a .js config when there is no .ts one", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.js", configSource("posts", "content.db"));

  const config = await loadConfig(dir);

  expect(config.configPath).toBe(join(dir, "pagedeck.config.js"));
  expect(config.collections.map((c) => c.name)).toEqual(["posts"]);
});

test("a .ts config wins over a .js one, so a site never syncs a stale build", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", configSource("fresh", "content.db"));
  writeConfig(dir, "pagedeck.config.js", configSource("stale", "content.db"));

  const config = await loadConfig(dir);

  expect(config.collections.map((c) => c.name)).toEqual(["fresh"]);
});

test("loadConfig rejects a directory with no config, naming the filenames it looked for", async () => {
  const dir = tempSiteDir();

  await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  await expect(loadConfig(dir)).rejects.toThrow(
    /No config file in .* pagedeck\.config\.ts, pagedeck\.config\.js/,
  );
});

test("loadConfig reports a config that throws while loading as a config error", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", `throw new Error("bad import");\n`);

  const error = await loadConfig(dir).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as ConfigError).message).toMatch(/failed to load/);
  expect((error as ConfigError).cause).toBeInstanceOf(Error);
});

test("loadConfig rejects a config whose default export is not a site config", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", `export default { store: 7 };\n`);

  await expect(loadConfig(dir)).rejects.toThrow(
    'must default-export a config with a string "store" path — export default defineConfig({ collections })',
  );
});

test("loadConfig rejects a config that skipped defineConfig, naming the collection", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    `export default { store: "content.db", collections: [{ name: "pages" }] };\n`,
  );

  await expect(loadConfig(dir)).rejects.toThrow(
    'collection "pages" is not ready to sync — pass the whole config through defineConfig({ collections })',
  );
});

test("loadConfig rejects a config with no collections, which would make sync a no-op", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    `export default { store: "content.db", collections: [] };\n`,
  );

  await expect(loadConfig(dir)).rejects.toThrow(/declares no collections/);
});

const wideLoader: Loader<{ frontmatter: Record<string, string> }> = {
  syncAll: () => ({ changed: [], deleted: [], cursor: 0 }),
  syncSince: () => ({ changed: [], deleted: [], cursor: 0 }),
  fetchOne: () => undefined,
};

const narrowingSchema = z.object({
  frontmatter: z.object({ section: z.enum(["how-to", "reference"]) }),
});

test("a config lists a collection whose schema narrows its loader's entry type", () => {
  const config = defineConfig({
    store: "content.db",
    collections: [
      {
        name: "docs",
        loader: wideLoader,
        schema: narrowingSchema,
        templates: {
          templateOf: (entry) => entry.data.frontmatter.section,
          byTemplate: {},
        },
      },
    ],
  });

  expect(config.collections.map((collection) => collection.name)).toEqual([
    "docs",
  ]);
});

test("a config cannot list a collection claiming a read type its loader does not produce", () => {
  const config = defineConfig({
    store: "content.db",
    collections: [
      // @ts-expect-error `schema: false` collapses the two entry types
      {
        name: "smuggled",
        loader: wideLoader,
        schema: false,
        extractUsage: (entry: Entry<{ frontmatter: { section: string } }>) => [
          {
            component: entry.data.frontmatter.section,
            count: 1,
            foldScore: 0,
            depth: 0,
            isRoot: true,
          },
        ],
      },
    ],
  });

  // The refusal is the type error above and nothing else: `defineConfig` reads
  // no types at runtime, so the call still returns a config.
  expect(config.collections.map((collection) => collection.name)).toEqual([
    "smuggled",
  ]);
});

test("loadConfig resolves a config that declares no store to content.db beside the config file", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    configSource("pages", "unused").replace(`store: "unused",`, ""),
  );

  const config = await loadConfig(dir);

  expect(config.storePath).toBe(join(dir, "content.db"));
});

const inertCollection = defineCollection({
  name: "pages",
  loader: wideLoader,
  schema: false,
});

test("a declared store wins over the default", () => {
  const config = defineConfig({
    store: "./data/site.db",
    collections: [inertCollection],
  });

  expect(config.store).toBe("./data/site.db");
});

test("a build section declaring no outDir writes the site to ./site", () => {
  const config = defineConfig({
    collections: [inertCollection],
    build: {
      pages: [fromCollection(inertCollection)],
      components: {},
      content: () => ({ tree: [] }),
    },
  });

  expect(config.build?.outDir).toBe("./site");
});

test("a declared outDir wins over the default", () => {
  const config = defineConfig({
    collections: [inertCollection],
    build: {
      outDir: "./dist",
      pages: [fromCollection(inertCollection)],
      components: {},
      content: () => ({ tree: [] }),
    },
  });

  expect(config.build?.outDir).toBe("./dist");
});

test("build.pages takes a bare list of sources, with the page set's defaults", () => {
  const dir = tempSiteDir();
  const store = openStore(join(dir, "content.db"));
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "index",
    data: {},
  });

  const config = defineConfig({
    collections: [inertCollection],
    build: {
      pages: [fromCollection(inertCollection)],
      components: {},
      content: () => ({ tree: [] }),
    },
  });
  const pages = config.build?.pages;

  try {
    expect(pages?.trailingSlash).toBe("never");
    expect([...(pages?.locales.keys() ?? [])]).toEqual(["en"]);
    expect(
      pages === undefined ? [] : collectPages(store, pages).map((p) => p.path),
    ).toEqual(["/"]);
  } finally {
    store.close();
  }
});

test("a page set built by definePages reaches the build section as declared", () => {
  const pages = definePages({
    trailingSlash: "always",
    locales: defineLocales({ de: { label: "Deutsch", direction: "ltr" } }),
    sources: [fromCollection(inertCollection)],
  });

  const config = defineConfig({
    collections: [inertCollection],
    build: { pages, components: {}, content: () => ({ tree: [] }) },
  });

  expect(config.build?.pages).toBe(pages);
});

function buildSectionSource(build: string): string {
  return `
export default {
  store: "content.db",
  collections: [
    {
      name: "pages",
      syncAll: () => ({ changed: [], deleted: [], cursor: 1 }),
      syncSince: () => ({ changed: [], deleted: [], cursor: 1 }),
    },
  ],
  build: ${build},
};
`;
}

test("a build section that is not an object is refused, naming the fields it takes", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`"./site"`));

  await expect(loadConfig(dir)).rejects.toThrow(
    '"build" must be an object — build: { pages, components, content }',
  );
});

test("a config with no default export names defineConfig and the one field it needs", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", `export const config = {};\n`);

  await expect(loadConfig(dir)).rejects.toThrow(
    "has no default export — export default defineConfig({ collections })",
  );
});

const MINIMAL_BUILD =
  `pages: {}, components: {}, ` +
  `content: () => ({ tree: [] }), outDir: "./dist"`;

test("a build section reports its budget's faults in the same run as its missing fields", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ outDir: "./dist", budget: { "pricing": "15kb", "/blog": "big" } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(`"build" is missing 3 fields`);
  expect(message).toContain(`"/blog" — "big"`);
  expect(message).toContain(`"pricing" — the path does not start with "/"`);
});

test("a build section carries a declared budget through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, budget: { "/pricing": "15kb" } }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.budget).toEqual({ "/pricing": "15kb" });
});

test("a build section reports its criticalCss faults the way it reports a budget's", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, criticalCss: { "landing": true, "/a/*": true, "/*/b": false, "/ok": "yes" } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.criticalCss" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing"`,
  );
  expect(message).toContain(`"landing" — the path does not start with "/"`);
  expect(message).toContain(`"/ok" — "yes"`);
  expect(message).toContain(`true or false`);
  expect(message).toContain(
    `"build.criticalCss" holds 1 pair of patterns no page can choose between`,
  );
  expect(message).toContain(`both match "/a/b"`);
});

test("a build section carries a declared criticalCss map through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, criticalCss: { "en:/landing/**": true } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.criticalCss).toEqual({ "en:/landing/**": true });
});

test("a build section reports a malformed foldStrategy beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, foldStrategy: { threshold: "8" } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.foldStrategy" declares a threshold that is not a tree position — write a whole number of nodes, 0 or more, such as { threshold: 8 }`,
  );
  expect(message).toContain(`"8" — not a number`);
  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
});

test("a build section refuses a foldStrategy that is neither a flag nor an object", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, foldStrategy: "on" }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.foldStrategy" must be true, false, or an object with a threshold — write foldStrategy: false to turn fold-driven hydration off, or foldStrategy: { threshold: 8 } to tune it`,
  );
});

test("a build section carries a declared foldStrategy through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, foldStrategy: { threshold: 3 } }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.foldStrategy).toEqual({ threshold: 3 });
});

test("a build section that declares no foldStrategy loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.foldStrategy).toBeUndefined();
});

test("a build section reports a malformed links setting beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, links: { broken: "false", brokn: "warn" } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.links" declares a setting no reference check can take — write "error" to fail the build on a broken reference, "warn" to report it and let the build finish, or false to skip the check:\n  "false" — not a reference-check setting`,
  );
  expect(message).toContain(
    `"build.links" declares 1 field this build does not read — delete the field, or correct it to one of: broken, external:\n  "brokn"`,
  );
  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
});

test("a build section refuses a links that is not an object", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, links: false }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.links" must be an object saying what a broken reference does — links: { broken: "warn" }`,
  );
});

test("a build section refuses an external link check that names no probe", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, links: { external: { limit: 0, intervalMs: -1, prob: () => 200 } } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.links.external" names no probe for this build to ask each URL with, and this framework ships none — declare the probe this build asks each URL with, as external: { probe: async (url) => (await fetch(url, { method: "HEAD" })).status }`,
  );
  expect(message).toContain(
    `"build.links.external" declares a limit that is not a count of requests — write a whole number of requests above zero, such as { limit: 20 }:\n  0 — below one`,
  );
  expect(message).toContain(
    `"build.links.external" declares an interval that is not a wait between requests — write a whole number of milliseconds, 0 or more, such as { intervalMs: 500 }:\n  -1 — below zero`,
  );
  expect(message).toContain(
    `"build.links.external" declares 1 field this build does not read — delete the field, or correct it to one of: probe, limit, intervalMs:\n  "prob"`,
  );
});

const BELOW_ONE =
  "below one, and a build reads the newest document in the store to record as its own parent, so a site that retains nothing cannot detect a raced deploy either";

test("a build section reports a retention count that is not a number of builds", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftThreshold: "5", retention: { keep: "20" } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.retention" is not a count of manifests to keep — write a whole number of builds, 1 or more, such as retention: { keep: 10 }:\n  "20" — not a number`,
  );
  expect(message).toContain(`"build.driftThreshold" is not a count`);
});

test("a retention count below one is refused, since a store that holds nothing detects nothing", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, retention: { keep: -1 } }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toContain(
    `  -1 — ${BELOW_ONE}`,
  );
});

test("keep: 0 is refused, because the store is what a raced deploy is detected from", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, retention: { keep: 0 } }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(`  0 — ${BELOW_ONE}`);
});

test("a retention count that is not whole is refused, since the store keeps documents", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, retention: { keep: 2.5 } }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toContain(
    `  2.5 — not a whole number, and the store keeps whole manifests`,
  );
});

test("a retention field this build does not read is refused rather than ignored", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, retention: { kepe: 5 } }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toContain(
    `"build.retention" declares 1 field this build does not read — delete the field, or correct it to "keep", the only field retention takes:\n  "kepe"`,
  );
});

test("a retention that is not an object at all is reported alone", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, retention: 20 }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toContain(
    `"build.retention" must be an object with a keep count — retention: { keep: 10 }`,
  );
});

test("a build section carries a declared retention policy through to the config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, retention: { keep: 3 } }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.retention).toEqual({ keep: 3 });
});

test("a build section that declares no retention loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.retention).toBeUndefined();
});

test("a build section carries a declared external link check through to the config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, links: { external: { probe: async () => 200, limit: 5 } } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.links?.external?.limit).toBe(5);
  expect(typeof config.build?.links?.external?.probe).toBe("function");
});

test("a build section carries a declared links through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, links: { broken: false } }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.links).toEqual({ broken: false });
});

test("a build section that declares no links loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.links).toBeUndefined();
});

test("a build section reports a drift threshold that is not a page count", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, driftThreshold: "5" }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.driftThreshold" is not a count of drifted pages — write a whole number of pages, 0 or more, such as driftThreshold: 3:\n  "5" — not a number`,
  );
  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
});

test("a build section reports an island props budget that is not a size beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, islandPropsBudget: "big" }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.islandPropsBudget" is not a size — write a number and a unit, one of b, kb or mb, such as "4kb":\n  "big"`,
  );
  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
});

test("a build section reports a drift supplement that is not a function", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftThreshold: "5", driftSupplement: "./theme.css" }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.driftSupplement" must be a function returning a stylesheet for the classes it is handed — driftSupplement: (classes) => compile(classes)`,
  );
  expect(message).toContain(`"build.driftThreshold" is not a count`);
});

test("a drift threshold below zero is refused, since no build drifts fewer than no pages", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, driftThreshold: -1 }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toContain(
    `  -1 — below zero, and a build that drifts no page is already the lowest count there is`,
  );
});

test("a build section carries a declared drift threshold through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, driftThreshold: 0 }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.driftThreshold).toBe(0);
});

test("a build section carries a declared supplement compiler through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftSupplement: (classes) => classes.map((name) => "." + name + "{}").join("") }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.driftSupplement?.(["badge-rogue"])).toBe(
    ".badge-rogue{}",
  );
});

test("a build section reports every unusable key of a declared safelist", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftThreshold: "5", safelist: { ` +
        `"hero.theme": "bg-white", ` +
        `"button.variant": ["bg-indigo-600 text-white"], ` +
        `"hero": [7], ` +
        `"feature_grid.columns": ["grid-cols-2"] } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.safelist" declares 3 keys that enumerate no class names — declare the classes each CMS styling field can render and each component states for itself, as safelist: { "hero.theme": ["bg-white", "text-slate-900"], "hero": ["hero"] }:\n` +
      `  "hero.theme" — is a string, not an array of class names\n` +
      `  "button.variant" — holds "bg-indigo-600 text-white", which is several classes in one string — declare each class on its own\n` +
      `  "hero" — holds a number, and a class name is a string`,
  );
  expect(message).not.toContain(`"feature_grid.columns"`);
  expect(message).toContain(`"build.driftThreshold" is not a count`);
});

test("a safelist that is not an object at all is reported alone", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, safelist: ["hero"] }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.safelist" must be an object keyed by where each class came from — the CMS styling field, or the component whose source states it — declare the classes each CMS styling field can render and each component states for itself, as safelist: { "hero.theme": ["bg-white", "text-slate-900"], "hero": ["hero"] }`,
  );
  expect(message).not.toContain(`"build.safelist" declares`);
});

test("a build section carries a declared safelist through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, safelist: { "hero.theme": ["bg-white", "text-slate-900"], "hero": ["hero"] } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.safelist).toEqual({
    "hero.theme": ["bg-white", "text-slate-900"],
    hero: ["hero"],
  });
});

test("a build section reports a search adapter it cannot index through beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftThreshold: "5", search: { name: "lunr" } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.search" declares 1 field this build cannot index through`,
  );
  expect(message).toContain(`"build.driftThreshold" is not a count`);
});

test("a build section carries a declared search adapter through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, search: { name: "lunr", index: (documents) => ` +
        `[{ path: "/search-index.json", kind: "asset", contents: String(documents.length) }] } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(await config.build?.search?.index([])).toEqual([
    { path: "/search-index.json", kind: "asset", contents: "0" },
  ]);
  expect(config.build?.search?.name).toBe("lunr");
});

test("a build section reports a font adapter it cannot subset through beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftThreshold: "5", fonts: { adapter: { name: "acme-subsetter" }, faces: [] } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.fonts.adapter" declares 1 field this build cannot subset through`,
  );
  expect(message).toContain(`"build.driftThreshold" is not a count`);
});

test("a build section reports a social-image adapter it cannot draw through beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, driftThreshold: "5", socialImages: { adapter: { name: "acme-cards" }, inputs: () => undefined } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.socialImages.adapter" declares 1 field this build cannot draw through`,
  );
  expect(message).toContain(`"build.driftThreshold" is not a count`);
});

test("a build section carries a declared social-image adapter through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, socialImages: { adapter: { name: "acme-cards", ` +
        `draw: (request) => ({ bytes: new Uint8Array([2]), width: 1200, height: 630 }) }, ` +
        `inputs: () => ({ title: "Pricing" }) } }`,
    ),
  );

  const config = await loadConfig(dir);

  const result = await config.build?.socialImages?.adapter.draw({
    page: { locale: "en", path: "/" } as never,
    title: "Pricing",
    inputs: {},
  });
  expect(result?.bytes).toEqual(new Uint8Array([2]));
  expect(result?.width).toBe(1200);
  expect(config.build?.socialImages?.adapter.name).toBe("acme-cards");
});

test("a build section carries a declared font adapter through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, fonts: { adapter: { name: "acme-subsetter", ` +
        `subset: (request) => ({ bytes: new Uint8Array([1]), metrics: { unitsPerEm: 1000, ascent: 1, descent: 1, lineGap: 0, xHeight: 1 } }) }, ` +
        `faces: [{ family: "Acme Sans", src: "/site/fonts/acme-sans.ttf", weight: 400, style: "normal", display: "swap", unicodeRanges: ["U+0-10FFFF"], fallback: ["Georgia"] }] } }`,
    ),
  );

  const config = await loadConfig(dir);

  const result = await config.build?.fonts?.adapter.subset({
    family: "Acme Sans",
    src: "/site/fonts/acme-sans.ttf",
    unicodeRanges: ["U+0-10FFFF"],
  });
  expect(result?.bytes).toEqual(new Uint8Array([1]));
  expect(config.build?.fonts?.adapter.name).toBe("acme-subsetter");
  expect(config.build?.fonts?.faces).toHaveLength(1);
});

test("a build section reports a malformed scripts setting beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, ` +
        `scripts: { scripts: [{ name: "analytics", src: "/a.js" }], ` +
        `pageTypes: { "blog": { analytics: "idle" } } } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(
    `"build.scripts.pageTypes" declares 1 key that is not a page pattern`,
  );
  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
});

test("a build section carries a declared scripts setting through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, scripts: { scripts: [{ name: "analytics", src: "/a.js" }] } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.scripts).toEqual({
    scripts: [{ name: "analytics", src: "/a.js" }],
  });
});

test("a build section that declares no scripts loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.scripts).toBeUndefined();
});

test("a build section reports a malformed beacon beside its other faults", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, beacon: { endpoint: 7 } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(`"build.beacon" cannot be used as declared`);
  expect(message).toContain("endpoint is 7");
  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
});

test("a build section that declares no beacon loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.beacon).toBeUndefined();
});

const BUILD_WITH_LOCALES =
  `pages: { locales: new Map([["en", { code: "en" }], ["de", { code: "de" }]]) }, ` +
  `components: {}, content: () => ({ tree: [] }), outDir: "./dist"`;

async function buildFault(build: string): Promise<string> {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(build));
  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return (error as Error).message;
}

test("a build section refuses an origin that is not a string", async () => {
  const message = await buildFault(`{ ${MINIMAL_BUILD}, origin: 7 }`);

  expect(message).toContain(
    `"build.origin" must be a string — write the scheme and host the site is served from and nothing else, as origin: "https://example.com"`,
  );
});

test("a build section refuses an origin that is not an absolute URL", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "example.com" }`,
  );

  expect(message).toContain(
    `"build.origin" is not a site origin — write the scheme and host the site is served from and nothing else, as origin: "https://example.com":\n  "example.com" — not an absolute URL, so it names no scheme and no host`,
  );
});

test("a build section refuses an origin whose scheme is not http or https", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "ftp://example.com" }`,
  );

  expect(message).toContain(
    `  "ftp://example.com" — the scheme is "ftp:", and a document links to an origin a browser fetches over http: or https:`,
  );
});

test("a build section refuses an origin that carries more than a scheme and a host", async () => {
  expect(
    await buildFault(
      `{ ${MINIMAL_BUILD}, origin: "https://example.com/shop" }`,
    ),
  ).toContain(
    `  "https://example.com/shop" — the origin holds the path "/shop", and this build appends each page's own path to it`,
  );
  expect(
    await buildFault(`{ ${MINIMAL_BUILD}, origin: "https://example.com/" }`),
  ).toContain(
    `  "https://example.com/" — it ends in a slash, and each page's path already starts with one`,
  );
  expect(
    await buildFault(`{ ${MINIMAL_BUILD}, origin: "https://example.com#top" }`),
  ).toContain(
    `  "https://example.com#…" — the origin holds a fragment, and an origin is a scheme and a host`,
  );
});

test("an origin's query and userinfo are named rather than quoted", async () => {
  const withQuery = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "https://example.com?token=SECRET" }`,
  );
  expect(withQuery).toContain(
    `  "https://example.com?…" — the origin holds a query, and an origin is a scheme and a host`,
  );
  expect(withQuery).not.toContain("SECRET");

  const withUserinfo = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "https://user:SECRET@example.com" }`,
  );
  expect(withUserinfo).toContain(
    `  "https://…@example.com" — the origin holds userinfo, and an origin is a scheme and a host`,
  );
  expect(withUserinfo).not.toContain("SECRET");
});

test("a password holding the delimiter is redacted before the quote is cut", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "https://user:pa?SECRET@example.com" }`,
  );

  expect(message).toContain(
    `  "https://…@example.com" — not an absolute URL, so it names no scheme and no host`,
  );
  expect(message).not.toContain("SECRET");
});

test("a value with no authority is redacted at its @ all the same", async () => {
  const bare = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "user:SECRET@example.com" }`,
  );
  expect(bare).toContain(
    `  "user:…@example.com" — the scheme is "user:", and a document links to an origin a browser fetches over http: or https:`,
  );
  expect(bare).toContain(
    `  "user:…@example.com" — the origin holds the path "…@example.com", and this build appends each page's own path to it`,
  );
  expect(bare).not.toContain("SECRET");

  const mail = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "mailto:SECRET@example.com" }`,
  );
  expect(mail).toContain(
    `  "mailto:…@example.com" — the scheme is "mailto:", and a document links to an origin a browser fetches over http: or https:`,
  );
  expect(mail).not.toContain("SECRET");
});

test("a slash in front of the @ does not walk past the userinfo span", async () => {
  const shapes: readonly (readonly [string, string])[] = [
    ["https://user:s3c/ret@example.com", `"https://…@example.com"`],
    ["https//user:s3cret@example.com", `"…@example.com"`],
    ["///user:s3cret@example.com", `"…@example.com"`],
    ["://user:s3cret@example.com", `"…@example.com"`],
    [" //user:s3cret@example.com", `"…@example.com"`],
  ];

  for (const [origin, shown] of shapes) {
    const message = await buildFault(
      `{ ${MINIMAL_BUILD}, origin: ${JSON.stringify(origin)} }`,
    );

    expect(message).toContain(
      `  ${shown} — not an absolute URL, so it names no scheme and no host`,
    );
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("s3c/ret");
  }
});

test("a build section reports an origin fault beside its other faults", async () => {
  const message = await buildFault(
    `{ outDir: "./dist", origin: "example.com" }`,
  );

  expect(message).toContain(`"build" is missing 3 fields`);
  expect(message).toContain(`"build.origin" is not a site origin`);
});

test("a build section carries a declared origin through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, origin: "https://example.com" }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.origin).toBe("https://example.com");
});

test("a build section that declares no origin loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.origin).toBeUndefined();
});

test("a build section refuses an xDefault that is not a string", async () => {
  const message = await buildFault(
    `{ ${BUILD_WITH_LOCALES}, origin: "https://example.com", xDefault: 7 }`,
  );

  expect(message).toContain(
    `"build.xDefault" must be a locale code — name one of the locales declared in build.pages.locales, as xDefault: "en"`,
  );
});

test("a build section refuses an xDefault naming a locale the site does not declare", async () => {
  const message = await buildFault(
    `{ ${BUILD_WITH_LOCALES}, origin: "https://example.com", xDefault: "fr" }`,
  );

  expect(message).toContain(
    `"build.xDefault" names a locale that is not declared — declare the locale, or point xDefault at a declared locale:\n  "fr" — the declared locales are "en", "de"`,
  );
});

test("a build section refuses an xDefault declared without an origin", async () => {
  const message = await buildFault(`{ ${BUILD_WITH_LOCALES}, xDefault: "en" }`);

  expect(message).toContain(
    `"build.xDefault" is declared without "build.origin", and the x-default link it names is an absolute URL — declare origin: "https://example.com", or remove xDefault`,
  );
});

test("a build section carries a declared xDefault through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${BUILD_WITH_LOCALES}, origin: "https://example.com", xDefault: "de" }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.xDefault).toBe("de");
});

test("a build section that declares no xDefault loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.xDefault).toBeUndefined();
});

const DOMAIN_MAPPED_LOCALES =
  `pages: { locales: new Map([["en", { code: "en", domain: "example.com" }], ` +
  `["de", { code: "de", domain: "example.de" }]]) }, components: {}, ` +
  `content: () => ({ tree: [] }), outDir: "./dist"`;

const FEED_SETTING =
  `feed: { collection: "posts", title: "My Site", ` +
  `description: "Recent posts", item: { title: "title" } }`;

test("a build section refuses a feed on a site no output tree of which serves the origin", async () => {
  const message = await buildFault(
    `{ ${DOMAIN_MAPPED_LOCALES}, origin: "https://www.example.com", ${FEED_SETTING} }`,
  );

  expect(message).toContain(
    `"build.feed" is declared on a site with no output tree to write it in — every locale is served from a domain of its own, none of them is the origin's host, and the feed is one file at the origin's own address — declare a locale with no domain, or point origin at one of the declared domains:\n  "https://www.example.com" — the declared domains are "example.com", "example.de"`,
  );
});

test("a build section carries a feed whose origin one of its declared domains serves", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${DOMAIN_MAPPED_LOCALES}, origin: "https://example.de", ${FEED_SETTING} }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.feed?.collection).toBe("posts");
});

test("a build section refuses a sitemap that is not an object", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "https://example.com", sitemap: true }`,
  );

  expect(message).toContain(
    `"build.sitemap" must be an object naming the URL pattern its files take — sitemap: { pattern: "suffix" }`,
  );
});

test("a build section refuses a sitemap pattern that is neither of the two", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, origin: "https://example.com", sitemap: { pattern: "flat" } }`,
  );

  expect(message).toContain(
    `"pattern" — "flat" — not a sitemap URL pattern — write "suffix" for /sitemap-en.xml, or "directory" for /en/sitemap.xml`,
  );
});

test("a build section refuses a sitemap declared without an origin", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, sitemap: { pattern: "suffix" } }`,
  );

  expect(message).toContain(
    `"build.sitemap" is declared without "build.origin", and every <loc> a sitemap holds is an absolute URL — declare origin: "https://example.com", or remove sitemap`,
  );
});

test("a build section carries a declared sitemap through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, origin: "https://example.com", sitemap: { pattern: "directory" } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.sitemap).toEqual({ pattern: "directory" });
});

test("a build section that declares no sitemap loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.sitemap).toBeUndefined();
});

test("a build section refuses a speculation setting that is not an object", async () => {
  const message = await buildFault(`{ ${MINIMAL_BUILD}, speculation: 5 }`);

  expect(message).toContain(
    `"build.speculation" must be an object naming the action its rules take and how many pages one may list — speculation: { action: "prefetch", max: 5 }`,
  );
});

test("a build section reports every unusable speculation field in one run", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, speculation: { action: "preload", max: "5" } }`,
  );

  expect(message).toContain(
    `"build.speculation" declares 2 fields this build cannot emit speculation rules from`,
  );
  expect(message).toContain(
    `  "action" — "preload" — not a speculation action — write "prefetch" to fetch the next page's bytes, or "prerender" to render it`,
  );
  expect(message).toContain(
    `  "max" — "5" — not a whole number of pages above zero — write the most pages one document may list, such as max: 5`,
  );
});

test("a build section refuses view transitions declared as anything but a boolean", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, viewTransitions: "auto" }`,
  );

  expect(message).toContain(
    `"build.viewTransitions" must be true or false — viewTransitions: true`,
  );
});

test("a build section carries both of #42's fields through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, viewTransitions: true, speculation: { action: "prerender", max: 3 } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.viewTransitions).toBe(true);
  expect(config.build?.speculation).toEqual({ action: "prerender", max: 3 });
});

test("a build section that declares neither of #42's fields loads with both absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.speculation).toBeUndefined();
  expect(config.build?.viewTransitions).toBeUndefined();
});

test("a build section refuses a pre-paint list that is not an array", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, prePaint: "theme()" }`,
  );

  expect(message).toContain(
    `"build.prePaint" must be an array of scripts to run before the browser paints`,
  );
});

test("a build section refuses a pre-paint snippet that would end its own element", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, prePaint: ["var end = '</script>'", "ok()", 7] }`,
  );

  expect(message).toContain(`"build.prePaint" declares 2 entries`);
  expect(message).toContain(`  prePaint[0] — holds "</script"`);
  expect(message).toContain(`  prePaint[2] — not a string`);
  expect(message).not.toContain("prePaint[1]");
});

test("a build section carries its pre-paint scripts through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, prePaint: ["window.theme = localStorage.theme"] }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.prePaint).toEqual(["window.theme = localStorage.theme"]);
});

test("a build section that declares no pre-paint script loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.prePaint).toBeUndefined();
});

test("a build section reports its css faults in the same run as its missing fields", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ outDir: "./dist", css: ["./global.css", 7, "", "  "] }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(`"build" is missing 3 fields`);
  expect(message).toContain(`"build.css" declares 3 entries`);
  expect(message).toContain(`css[1] — not a string`);
  expect(message).toContain(`css[2] — "" — the path is empty`);
  expect(message).toContain(`css[3] — "  " — the path is only whitespace`);
  expect(message).not.toContain(`css[0]`);
});

test("a build section refuses a css value that is not an array", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, css: "./global.css" }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.css" must be an array of stylesheet paths — css: ["./styles/global.css"]`,
  );
});

test("a build section refuses a vite plugin that is not a plugin object", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, vite: { plugins: [` +
        `[{ name: "many-a" }, { name: "many-b" }], false, () => ({})` +
        `] } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain(`"build.vite.plugins" declares 1 entry`);
  expect(message).toContain(`plugins[2] — not a plugin object`);
  expect(message).toContain(`call the factory`);
});

test("a build section refuses a vite section that is not an object", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, vite: [] }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(`"build.vite" must be an object`);
});

test("a build section carries declared css and vite plugins through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, css: ["./global.css"], vite: { plugins: [{ name: "site:one" }] } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.css).toEqual(["./global.css"]);
  expect(config.build?.vite?.plugins).toEqual([{ name: "site:one" }]);
});

test("a build section refuses a head that is not a function", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, head: { title: "Site" } }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.head" must be a function returning one page's head fields — head: (page, store) => ({ title: "…" })`,
  );
});

test("a build section refuses a chrome that is not a function", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, chrome: { before: [] } }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.chrome" must be a function returning one page's chrome — chrome: (page, store) => ({ before: [{ component: "Nav" }], after: [{ component: "Footer" }] })`,
  );
});

test("a build section carries a declared head through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, head: () => ({ title: "Site" }) }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.head?.({} as never, {} as never)).toEqual({
    title: "Site",
  });
});

test("a build section that declares no head loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.head).toBeUndefined();
});

test("a build section refuses a rootProviders that is not an object", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, rootProviders: "./providers.js" }`,
  );

  expect(message).toContain(
    `"build.rootProviders" must be an object holding the stack and the module it is imported from — declare both halves, as rootProviders: { stack: providers, module: "./providers.js" }`,
  );
});

test("a build section refuses a stack the render can apply and no module the entry can import", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, rootProviders: { stack: [{ component: () => null }] } }`,
  );

  expect(message).toContain(
    `"build.rootProviders" names no module for an island entry to import the stack from`,
  );
});

test("a build section refuses a module with no stack for the build-time render", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, rootProviders: { module: "./providers.js" } }`,
  );

  expect(message).toContain(
    `"build.rootProviders" declares a stack this build cannot apply`,
  );
  expect(message).toContain(`"stack" — absent`);
});

test("a build section refuses an empty stack, which is what an absent field already means", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, rootProviders: { stack: [], module: "./providers.js" } }`,
  );

  expect(message).toContain(`"stack" — declares no providers`);
});

test("a build section reports every unusable provider in the stack, by index", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, rootProviders: { stack: [7, { component: undefined }, { component: () => null, props: 3 }], module: "./providers.js" } }`,
  );

  expect(message).toContain(`stack[0] — not an object`);
  expect(message).toContain(`stack[1].component — not a component`);
  expect(message).toContain(`stack[2].props — not an object`);
});

test("a build section refuses a rootProviders field this build does not read", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, rootProviders: { stack: [{ component: () => null }], module: "./providers.js", modules: {} } }`,
  );

  expect(message).toContain(
    `"build.rootProviders" declares 1 field this build does not read`,
  );
  expect(message).toContain(`"modules"`);
});

test("a build section reports a malformed rootProviders beside its other faults", async () => {
  const message = await buildFault(
    `{ ${MINIMAL_BUILD}, budget: { "blog": "15kb" }, rootProviders: { stack: [], module: "" } }`,
  );

  expect(message).toContain(
    `"build.budget" declares 1 key that is not a page pattern`,
  );
  expect(message).toContain(`"stack" — declares no providers`);
  expect(message).toContain(`"module" — "" — the specifier is empty`);
});

test("a build section carries a declared rootProviders through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, rootProviders: { stack: [{ component: () => null, props: { store: {} } }], module: "./providers.js" } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.rootProviders?.module).toBe("./providers.js");
  expect(config.build?.rootProviders?.stack).toHaveLength(1);
});

test("a build section that declares no rootProviders loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.rootProviders).toBeUndefined();
});

test("a build section reports every routing rule field that is not the type the pass reads", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: {
        redirects: [{ from: 7, to: "/pricing", status: "301" }],
        notFound: [{ locale: "en" }],
        headers: [{ prefix: "/docs/" }],
      } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.routing" declares 4 rule fields this build cannot route with — declare each as the type its own line names:
  redirects[0] — "from" — 7 — not a string — write the path this rule starts at, as authored, such as "/old"
  redirects[0] — "status" — "301" — not a number — write the 3xx a static host answers with, as status: 301, or leave it out for 308
  notFound[0] — "path" — undefined — not a string — write the path the route table spells this page with, such as "/404"
  headers[0] — "set" — undefined — not a list of header fields — write the headers this prefix carries, as set: [{ name: "X-Frame-Options", value: "DENY" }]`,
  );
});

test("a routing key this build does not read is refused rather than ignored", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: { redirect: [{ from: "/old", to: "/" }] } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toContain(
    `"build.routing" declares 1 field this build does not read — delete the field, or correct it to one of: redirects, notFound, headers, experiments:\n  "redirect"`,
  );
});

test("a routing member that is not a list, and an entry that is not a rule, are two paragraphs", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: { notFound: 7, redirects: ["/old"] } }`,
    ),
  );

  const message = (
    (await loadConfig(dir).catch((thrown: unknown) => thrown)) as Error
  ).message;

  expect(message).toContain(
    `"build.routing" declares 1 member that is not a list of rules — write each as an array, as routing: { redirects: [{ from: "/old", to: "/pricing" }] }:\n  "notFound" — 7`,
  );
  expect(message).toContain(
    `"build.routing" declares 1 entry that is not a rule — write each as an object, as routing: { redirects: [{ from: "/old", to: "/pricing" }] }:\n  redirects[0] — "/old"`,
  );
});

test("a routing that is not an object at all is reported alone", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${MINIMAL_BUILD}, routing: [] }`),
  );

  const message = (
    (await loadConfig(dir).catch((thrown: unknown) => thrown)) as Error
  ).message;

  expect(message).toContain(
    `"build.routing" must be an object of redirects, 404 pages, header rules and experiments — routing: { redirects: [{ from: "/old", to: "/pricing" }] }`,
  );
  expect(message).not.toContain("declares");
});

test("a routing value that could hold a credential is cut at its query before it is quoted", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: { redirects: [{ from: "  ", to: "" }] } }`,
    ),
  );

  const message = (
    (await loadConfig(dir).catch((thrown: unknown) => thrown)) as Error
  ).message;

  expect(message).toContain(
    `redirects[0] — "from" — "  " — the path is only whitespace`,
  );
  expect(message).toContain(`redirects[0] — "to" — "" — the path is empty`);
});

test("a routing rule leaving an optional member explicitly undefined is not a fault", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: {
        redirects: [{ from: "/old", to: "/pricing", domain: undefined, status: undefined }],
        notFound: [{ locale: "en", path: "/404", domain: undefined }],
        headers: [{ prefix: "/docs/", set: [], domain: undefined }],
      } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.routing?.redirects).toEqual([
    { from: "/old", to: "/pricing", domain: undefined, status: undefined },
  ]);
});

test("a header set entry that is an array is reported as an entry that is not a rule", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: {
        headers: [{ prefix: "/docs/", set: [["X-Frame-Options", "DENY"]] }],
      } }`,
    ),
  );

  const message = (
    (await loadConfig(dir).catch((thrown: unknown) => thrown)) as Error
  ).message;

  expect(message).toContain(
    `"build.routing" declares 1 entry that is not a rule — write each as an object, as routing: { redirects: [{ from: "/old", to: "/pricing" }] }:\n  headers[0].set[0] — ["X-Frame-Options","DENY"]`,
  );
  expect(message).not.toContain("not a string");
});

test("a build section carries a declared routing config through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: { redirects: [{ from: "/old", to: "/pricing", status: 301 }] } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.routing?.redirects).toEqual([
    { from: "/old", to: "/pricing", status: 301 },
  ]);
});

test("a build section carries a declared experiment through to the loaded config", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: { experiments: [{ locale: "en", path: "/pricing", cookie: "fw_pricing", variants: [{ name: "b", weight: 50 }] }] } }`,
    ),
  );

  const config = await loadConfig(dir);

  expect(config.build?.routing?.experiments).toEqual([
    {
      locale: "en",
      path: "/pricing",
      cookie: "fw_pricing",
      variants: [{ name: "b", weight: 50 }],
    },
  ]);
});

test("a build section reports every experiment field that is not the type the pass reads", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(
      `{ ${MINIMAL_BUILD}, routing: {
        experiments: [
          { locale: "en", path: "/pricing", cookie: 7 },
          { locale: "en", path: "/about", cookie: "fw_about", variants: [{ name: 2, weight: "50" }] },
        ],
      } }`,
    ),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    `"build.routing" declares 4 rule fields this build cannot route with — declare each as the type its own line names:
  experiments[0] — "cookie" — 7 — not a string — write the cookie key this experiment is assigned and read by, such as "fw_pricing"
  experiments[0] — "variants" — undefined — not a list of variants — write the variants of this experiment, as variants: [{ name: "b", weight: 50 }]
  experiments[1].variants[0] — "name" — 2 — not a string — write the variant name as one path segment, such as "b"
  experiments[1].variants[0] — "weight" — "50" — not a number — write this variant's share of visitors, such as weight: 50`,
  );
});

test("a build section that declares no routing loads with the field absent", async () => {
  const dir = tempSiteDir();
  writeConfig(dir, "pagedeck.config.ts", buildSectionSource(`{ ${MINIMAL_BUILD} }`));

  const config = await loadConfig(dir);

  expect(config.build?.routing).toBeUndefined();
});

const COMPONENT_BUILD =
  `pages: {}, content: () => ({ tree: [] }), outDir: "./dist"`;

function componentSite(): string {
  const dir = tempSiteDir();
  mkdirSync(join(dir, "components"));
  for (const name of ["Hero", "Lead", "Legacy"]) {
    writeFileSync(
      join(dir, "components", `${name}.js`),
      `export default function ${name}() { return "marker-${name.toLowerCase()}-5e0c"; }\n`,
    );
  }
  return dir;
}

test("a component declared by path loads as a loader for the render and an entry in the module map", async () => {
  const dir = componentSite();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: {
        hero: "./components/Hero.js",
        lead: { path: "./components/Lead.js", hydrate: "load" },
        legacy: { path: "./components/Legacy.js", hydrate: "idle" },
      },
    }`),
  );

  const config = await loadConfig(dir);
  const build = config.build;
  if (build === undefined) throw new Error("the config loaded with no build");

  expect(build.componentModules).toEqual({
    hero: "./components/Hero.js",
    lead: "./components/Lead.js",
    legacy: "./components/Legacy.js",
  });
  expect(build.components.lead?.hydrate).toBe("load");
  expect(build.components.legacy?.hydrate).toBe("idle");
  expect(build.components.hero?.hydrate).toBeUndefined();
  for (const name of ["hero", "lead", "legacy"]) {
    const module = (await build.components[name]?.import()) as {
      default: () => string;
    };
    expect(module.default()).toBe(`marker-${name}-5e0c`);
  }
});

test("a relative or absolute component path is resolved against the config file's directory, however it is spelled", async () => {
  const dir = componentSite();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: {
        hero: "./components/Hero.js",
        lead: "./components/../components/Lead.js",
        legacy: ${JSON.stringify(join(dir, "components", "Legacy.js"))},
      },
    }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.componentModules).toEqual({
    hero: "./components/Hero.js",
    lead: "./components/Lead.js",
    legacy: "./components/Legacy.js",
  });
  const module = (await config.build?.components.hero?.import()) as {
    default: () => string;
  };
  expect(module.default()).toBe("marker-hero-5e0c");
});

test("a build section that declares no components loads with an empty module map", async () => {
  const dir = tempSiteDir();
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD}, components: {} }`),
  );

  const config = await loadConfig(dir);

  expect(config.build?.componentModules).toEqual({});
});

test("a config that still declares build.modules fails at load, naming each entry to move under build.components", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: { hero: "./components/Hero.js" },
      modules: { hero: "./components/Hero.js", pricing: "@acme/ds/pricing" },
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules"; it lists 2 components to declare there by these paths:
  "hero" — "./components/Hero.js"
  "pricing" — "@acme/ds/pricing"`,
  );
});

test("one build.modules entry is named in the singular", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: { hero: "./components/Hero.js" },
      modules: { hero: "./components/Hero.js" },
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toBe(
    `Config "${configPath}": "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules"; it lists 1 component to declare there by this path:
  "hero" — "./components/Hero.js"`,
  );
});

test("a build.modules with no entry it can read shows the path form by example", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: { hero: "./components/Hero.js" },
      modules: 7,
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules", as components: { counter: "./components/counter.tsx" }`,
  );
});

test("build.modules is refused in the same run as the build section's other faults", async () => {
  const dir = tempSiteDir();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: { hero: "" },
      modules: {},
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": "build.components" holds 1 component that is not usable — fix each one:
  "hero": path is empty — ${REGISTRY_FIX}

Config "${configPath}": "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules", as components: { counter: "./components/counter.tsx" }`,
  );
});

test("a component declared by a loader fails at load, pointing to the path form", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: {
        hero: "./components/Hero.js",
        legacy: { import: () => import("./components/Legacy.js"), hydrate: "idle" },
        lead: { path: "./components/Lead.js", import: () => import("./components/Lead.js") },
      },
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": "build.components" holds 2 components that are not usable — fix each one:
  "legacy": declares a loader, import, which was removed — ${REGISTRY_FIX}
  "lead": declares both path and import, and import was removed — keep path and drop import`,
  );
});

const REGISTRY_FIX =
  'name its module by a path relative to the config file, such as "./components/<module>.tsx", or by a package specifier, such as "<package>/<module>"';

test("a components map that skipped defineComponents is shape-checked at load", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: { hero: "", lead: "./components/Lead.js", legacy: { hydrate: "load" } },
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": "build.components" holds 2 components that are not usable — fix each one:
  "hero": path is empty — ${REGISTRY_FIX}
  "legacy": declares no path — ${REGISTRY_FIX}`,
  );
});

test("a component whose path names no file, or whose specifier resolves to nothing, fails at load naming each one", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: {
        hero: "./components/Hero.js",
        ghost: "./components/Ghost.js",
        phantom: { path: "@pagedeck/phantom/widget", hydrate: "load" },
      },
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": 2 components declare a module that does not resolve — point each path at a file, relative to this config file, or install the package each specifier names:
  "ghost" — "./components/Ghost.js" resolves to "${join(dir, "components", "Ghost.js")}", and no file is there
  "phantom" — "@pagedeck/phantom/widget" resolves to no module from "${configPath}"`,
  );
}, 60_000);

test("one component that does not resolve is named in the singular", async () => {
  const dir = componentSite();
  const configPath = join(dir, "pagedeck.config.ts");
  writeConfig(
    dir,
    "pagedeck.config.ts",
    buildSectionSource(`{ ${COMPONENT_BUILD},
      components: { ghost: "./components" },
    }`),
  );

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${configPath}": 1 component declares a module that does not resolve — point its path at a file, relative to this config file, or install the package its specifier names:
  "ghost" — "./components" resolves to "${join(dir, "components")}", and no file is there`,
  );
});

const PAGES_MODULE = join(import.meta.dirname, "pages.ts");

function layoutSiteSource(build: string): string {
  return `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};
import { fromCollection, paginate } from ${JSON.stringify(PAGES_MODULE)};

const pages = {
  name: "pages",
  loader: {
    syncAll: () => ({ changed: [], deleted: [], cursor: 1 }),
    syncSince: () => ({ changed: [], deleted: [], cursor: 1 }),
  },
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: ${build},
});
`;
}

function layoutSite(build: string): string {
  const dir = tempSiteDir();
  writeFileSync(
    join(dir, "layout.js"),
    "export default function Layout() { return null; }\n",
  );
  writeConfig(dir, "pagedeck.config.ts", layoutSiteSource(build));
  return dir;
}

test("a build section whose every page source names a layout needs no content callback", async () => {
  const dir = layoutSite(
    `{ pages: [fromCollection(pages, { layout: "layout" })], components: { layout: "./layout.js" } }`,
  );

  const config = await loadConfig(dir);

  expect(config.build?.content).toBeUndefined();
  expect(config.build?.pages.layouts).toEqual(["layout"]);
});

test("a content callback loads beside a layout, for the pages whose source names none", async () => {
  const dir = layoutSite(`{
    pages: [
      fromCollection(pages, { layout: "layout" }),
      paginate({ pageSize: 10, lists: () => [] }),
    ],
    components: { layout: "./layout.js" },
    content: () => ({ tree: [] }),
  }`);

  const config = await loadConfig(dir);

  expect(typeof config.build?.content).toBe("function");
  expect(config.build?.pages.layouts).toEqual(["layout", undefined]);
});

test("a layout build.components does not register is refused at load, naming every such source and the registered names", async () => {
  const dir = layoutSite(`{
    pages: [
      fromCollection(pages, { layout: "Layout" }),
      fromCollection(pages, { layout: "layout" }),
      fromCollection(pages, { layout: "./layout.js", route: () => undefined }),
    ],
    components: { layout: "./layout.js", counter: "./layout.js" },
  }`);

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${join(dir, "pagedeck.config.ts")}": "build.pages" names 2 layouts that build.components does not register — register each under build.components, or name a registered component, which are "counter", "layout":
  sources[0] — layout "Layout"
  sources[2] — layout "./layout.js"`,
  );
});

test("a build section with no content callback and a source naming no layout reports content as missing", async () => {
  const dir = layoutSite(`{
    pages: [
      fromCollection(pages, { layout: "layout" }),
      paginate({ pageSize: 10, lists: () => [] }),
    ],
    components: { layout: "./layout.js" },
  }`);

  const error: unknown = await loadConfig(dir).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    `Config "${join(dir, "pagedeck.config.ts")}": "build" is missing 1 field pagedeck build needs — declare each in the build section:
  "content" — declare it as a function, or name a layout on every page source`,
  );
});
