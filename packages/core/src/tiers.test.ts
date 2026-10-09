import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import type { PageEntry } from "./entries.js";
import {
  DEFAULT_TIER_POLICY,
  assertModuleIds,
  codeSplitting,
  planTiers,
} from "./tiers.js";
import type { TierAssignment } from "./tiers.js";
import type { ComponentRanking } from "@pagedeck/content";

function entry(
  path: string,
  components: readonly string[],
  providers?: string,
  deferred: readonly string[] = [],
): PageEntry {
  const name = path === "/" ? "index" : path.slice(1);
  return {
    locale: "en",
    path,
    id: `\0fw:entry/${name}`,
    name,
    components: components.map((component) => ({
      name: component,
      module: `@ds/${component}`,
      eager: !deferred.includes(component),
    })),
    ...(providers === undefined ? {} : { providers }),
  };
}

function mapped(
  path: string,
  modules: Readonly<Record<string, string>>,
): PageEntry {
  const one = entry(path, Object.keys(modules));
  return {
    ...one,
    components: one.components.map((component) => ({
      ...component,
      module: modules[component.name] ?? component.module,
    })),
  };
}

function ranked(
  component: string,
  totalUsages: number,
  storyCount: number,
  avgFoldScore: number,
): ComponentRanking {
  return {
    component,
    totalUsages,
    storyCount,
    avgPerStory: totalUsages / storyCount,
    avgFoldScore,
  };
}

// One fixture for every boundary: `Nav` on 3/5 (`coreMinShare` exactly), `Signup` on
// exactly `midMinPages`.
const ENTRIES: readonly PageEntry[] = [
  entry("/", ["Hero", "Nav", "Signup", "Analytics"]),
  entry("/pricing", ["Hero", "Nav", "Signup", "Analytics"]),
  entry("/about", ["Hero", "Nav", "Analytics"]),
  entry("/blog", ["Hero", "Analytics"]),
  entry("/blog/one", ["Hero", "Chart"]),
];

const RANKING: readonly ComponentRanking[] = [
  ranked("Hero", 9, 5, 0),
  ranked("Analytics", 4, 4, 12),
  ranked("Nav", 3, 3, 1),
  ranked("Signup", 2, 2, 7),
  ranked("Chart", 1, 1, 4),
];

function tierOf(assignments: readonly TierAssignment[], component: string) {
  return assignments.find((one) => one.component === component);
}

test("share decides core, page count decides mid, and one page is tail", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });

  expect(plan.pageCount).toBe(5);
  expect(tierOf(plan.assignments, "Hero")).toMatchObject({
    tier: "core",
    group: "fw-core",
    pageCount: 5,
    pageShare: 1,
  });
  expect(tierOf(plan.assignments, "Nav")).toMatchObject({
    tier: "core",
    group: "fw-core",
    pageCount: 3,
  });
  expect(tierOf(plan.assignments, "Signup")).toMatchObject({
    tier: "mid",
    group: "fw-mid",
    pageCount: 2,
  });
  expect(tierOf(plan.assignments, "Chart")).toMatchObject({
    tier: "tail",
    pageCount: 1,
  });
  expect(tierOf(plan.assignments, "Chart")?.group).toBeUndefined();
});

test("a component on one page is tail however heavily that page uses it", () => {
  const plan = planTiers({
    entries: ENTRIES,
    ranking: [...RANKING.slice(0, 4), ranked("Chart", 400, 1, 0)],
  });

  expect(tierOf(plan.assignments, "Chart")).toMatchObject({
    tier: "tail",
    totalUsages: 400,
  });
  expect(plan.groups.flatMap((group) => group.modules)).not.toContain(
    "@ds/Chart",
  );
});

test("excluding a component drops its row and moves nobody else's", () => {
  const plan = planTiers({
    entries: ENTRIES,
    ranking: RANKING.filter((one) => one.component !== "Analytics"),
    policy: { exclude: ["Analytics"] },
  });

  expect(tierOf(plan.assignments, "Analytics")).toBeUndefined();
  expect(plan.groups.flatMap((group) => group.modules)).not.toContain(
    "@ds/Analytics",
  );
  expect(tierOf(plan.assignments, "Nav")?.pageShare).toBe(3 / 5);
  expect(plan.pageCount).toBe(5);
});

test("a component the ranking never saw still tiers, with zeroed columns", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: [] });

  expect(tierOf(plan.assignments, "Hero")).toMatchObject({
    tier: "core",
    totalUsages: 0,
    avgFoldScore: 0,
  });
});

test("the ranking pulls a mid component into core, and only the ranking does", () => {
  const hot = planTiers({
    entries: ENTRIES,
    ranking: RANKING.map((one) =>
      one.component === "Signup" ? ranked("Signup", 500, 2, 7) : one,
    ),
  });
  const cold = planTiers({ entries: ENTRIES, ranking: RANKING });

  expect(tierOf(hot.assignments, "Signup")).toMatchObject({
    tier: "core",
    group: "fw-core",
    pageCount: 2,
  });
  expect(tierOf(cold.assignments, "Signup")).toMatchObject({
    tier: "mid",
    group: "fw-mid",
    pageCount: 2,
  });
  expect(hot.assignments).not.toEqual(cold.assignments);
  expect(
    hot.groups.find((group) => group.name === "fw-core")?.modules,
  ).toContain("@ds/Signup");
  expect(hot.groups.map((group) => group.name)).toEqual(["fw-core"]);
});

test("the usage boundary is the caller's to move", () => {
  const plan = planTiers({
    entries: ENTRIES,
    ranking: RANKING,
    policy: { coreMinShare: 0.9, coreMinUsageShare: 0.15 },
  });

  expect(tierOf(plan.assignments, "Nav")).toMatchObject({
    tier: "core",
    pageShare: 3 / 5,
  });
  expect(tierOf(plan.assignments, "Signup")?.tier).toBe("mid");
});

test("a ranked component no page imports does not dilute the boundary", () => {
  const withGhost = planTiers({
    entries: ENTRIES,
    ranking: [
      ...RANKING.map((one) =>
        one.component === "Signup" ? ranked("Signup", 500, 2, 7) : one,
      ),
      ranked("Unrouted", 100_000, 20, 0),
    ],
  });

  expect(tierOf(withGhost.assignments, "Signup")?.tier).toBe("core");
});

test("a component that never hydrates on load is in no group, however many pages use it", () => {
  const plan = planTiers({
    entries: ENTRIES.map((one) =>
      entry(
        one.path,
        [...one.components.map((component) => component.name), "Search"],
        undefined,
        ["Search"],
      ),
    ),
    ranking: [...RANKING, ranked("Search", 5, 5, 0)],
  });

  expect(tierOf(plan.assignments, "Search")).toEqual({
    component: "Search",
    module: "@ds/Search",
    tier: "tail",
    pageCount: 5,
    pageShare: 1,
    totalUsages: 5,
    usageShare: 5 / 24,
    avgFoldScore: 0,
  });
  expect(plan.groups.flatMap((group) => group.modules)).not.toContain(
    "@ds/Search",
  );
  expect(tierOf(plan.assignments, "Hero")?.tier).toBe("core");
});

test("one page hydrating it on load tiers a component as before", () => {
  const plan = planTiers({
    entries: ENTRIES.map((one) =>
      entry(
        one.path,
        [...one.components.map((component) => component.name), "Search"],
        undefined,
        one.path === "/about" ? [] : ["Search"],
      ),
    ),
    ranking: [...RANKING, ranked("Search", 5, 5, 0)],
  });

  expect(tierOf(plan.assignments, "Search")).toMatchObject({
    tier: "core",
    group: "fw-core",
    pageCount: 5,
  });
  expect(
    plan.groups.find((group) => group.name === "fw-core")?.modules,
  ).toContain("@ds/Search");
});

test("an eager name tiers every name sharing its module", () => {
  const pack = "@ds/pack";
  const deferredPack = (path: string): PageEntry => {
    const one = mapped(path, { Card: pack, CardFooter: pack });
    return {
      ...one,
      components: one.components.map((component) => ({
        ...component,
        eager: path === "/" && component.name === "CardFooter",
      })),
    };
  };
  const plan = planTiers({
    entries: ["/", "/pricing", "/about"].map(deferredPack),
    ranking: [],
  });

  expect(tierOf(plan.assignments, "Card")).toMatchObject({
    tier: "core",
    group: "fw-core",
  });
  expect(tierOf(plan.assignments, "CardFooter")).toMatchObject({
    tier: "core",
    group: "fw-core",
  });
});

test("a ranked component no page imports gets no assignment", () => {
  const plan = planTiers({
    entries: ENTRIES,
    ranking: [...RANKING, ranked("Unrouted", 50, 20, 0)],
  });

  expect(tierOf(plan.assignments, "Unrouted")).toBeUndefined();
});

test("assignments are sorted by component name", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });

  expect(plan.assignments.map((one) => one.component)).toEqual([
    "Analytics",
    "Chart",
    "Hero",
    "Nav",
    "Signup",
  ]);
});

test("the runtime and the provider stack are pinned into core", () => {
  const plan = planTiers({
    entries: [
      entry("/", ["Hero"], "@site/providers"),
      entry("/pricing", ["Hero"], "@site/providers"),
    ],
    ranking: [ranked("Hero", 2, 2, 0)],
  });

  const core = plan.groups.find((group) => group.name === "fw-core");
  expect(core?.modules).toEqual([
    "@ds/Hero",
    "@pagedeck/islands/runtime",
    "@site/providers",
  ]);
  expect(plan.assignments.map((one) => one.component)).toEqual(["Hero"]);
});

test("a caller narrowing alwaysCore cannot unpin the islands runtime", () => {
  const plan = planTiers({
    entries: ENTRIES,
    ranking: RANKING,
    alwaysCore: ["@site/extra"],
  });

  const core = plan.groups.find((group) => group.name === "fw-core");
  expect(core?.modules).toContain("@pagedeck/islands/runtime");
  expect(core?.modules).toContain("@site/extra");
});

test("two registry names on one specifier record the tier that ships", () => {
  const pack = "@ds/pack";
  const plan = planTiers({
    entries: [
      mapped("/", { Card: pack, CardFooter: pack }),
      mapped("/pricing", { Card: pack, CardFooter: pack }),
      mapped("/about", { Card: pack }),
      mapped("/blog", { Card: pack }),
      mapped("/blog/one", { Card: pack }),
    ],
    ranking: [],
  });

  expect(tierOf(plan.assignments, "Card")).toMatchObject({
    tier: "core",
    group: "fw-core",
    pageCount: 5,
  });
  expect(tierOf(plan.assignments, "CardFooter")).toMatchObject({
    tier: "core",
    group: "fw-core",
    pageCount: 5,
  });
  expect(plan.groups.map((group) => group.name)).toEqual(["fw-core"]);
});

test("a specifier's demand is every page reaching it, not each name's own", () => {
  const pack = "@ds/pack";
  const plan = planTiers({
    entries: [
      mapped("/", { Card: pack }),
      mapped("/pricing", { Card: pack }),
      mapped("/about", { CardFooter: pack }),
      mapped("/blog", { CardFooter: pack }),
      mapped("/blog/one", { Chart: "@ds/Chart" }),
    ],
    ranking: [],
  });

  expect(tierOf(plan.assignments, "Card")).toMatchObject({
    tier: "core",
    pageCount: 4,
    pageShare: 0.8,
  });
  expect(tierOf(plan.assignments, "CardFooter")).toMatchObject({
    tier: "core",
    pageCount: 4,
    pageShare: 0.8,
  });
});

test("the two groups carry the settings the prototype validated", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });

  expect(plan.groups.map((group) => group.name)).toEqual(["fw-core", "fw-mid"]);
  expect(plan.groups[0]).toMatchObject({
    priority: 30,
    entriesAware: false,
    minSize: DEFAULT_TIER_POLICY.minSize,
    minShareCount: DEFAULT_TIER_POLICY.minShareCount,
  });
  expect(plan.groups[1]).toMatchObject({
    priority: 20,
    entriesAware: true,
    entriesAwareMergeThreshold: DEFAULT_TIER_POLICY.minSize,
  });
});

test("a plan with no mid component emits no mid group", () => {
  const plan = planTiers({
    entries: [entry("/", ["Hero"]), entry("/pricing", ["Hero", "Chart"])],
    ranking: [],
  });

  expect(plan.groups.map((group) => group.name)).toEqual(["fw-core"]);
});

test("the resolved policy travels with the plan", () => {
  const plan = planTiers({
    entries: ENTRIES,
    ranking: RANKING,
    policy: { coreMinShare: 0.9 },
  });

  expect(plan.policy).toEqual({
    ...DEFAULT_TIER_POLICY,
    coreMinShare: 0.9,
  });
  expect(tierOf(plan.assignments, "Nav")?.tier).toBe("mid");
});

test("every out-of-range policy setting is reported at once", () => {
  expect(() =>
    planTiers({
      entries: ENTRIES,
      ranking: RANKING,
      policy: {
        coreMinShare: 1.5,
        midMinPages: 0,
        minSize: -1,
        minShareCount: 1.5,
      },
    }),
  ).toThrow(
    new ConfigError(
      [
        "Chunk tiers: 4 policy settings are out of range — correct each, or drop it to take the default:",
        "  coreMinShare 1.5 — must be greater than 0 and at most 1",
        "  midMinPages 0 — must be a whole number of pages, at least 1",
        "  minSize -1 — must be a whole number of bytes, at least 0",
        "  minShareCount 1.5 — must be a whole number of entry chunks, at least 1",
      ].join("\n"),
    ),
  );
});

test("one out-of-range setting reads in the singular", () => {
  expect(() =>
    planTiers({
      entries: ENTRIES,
      ranking: RANKING,
      policy: { midMinPages: 0 },
    }),
  ).toThrow(
    new ConfigError(
      [
        "Chunk tiers: 1 policy setting is out of range — correct it, or drop it to take the default:",
        "  midMinPages 0 — must be a whole number of pages, at least 1",
      ].join("\n"),
    ),
  );
});

test("a policy fault is a wiring fault", () => {
  expect(() =>
    planTiers({
      entries: ENTRIES,
      ranking: RANKING,
      policy: { midMinPages: 0 },
    }),
  ).toThrow(ConfigError);
});

test("a page that spells a group name is refused", () => {
  expect(() =>
    planTiers({
      entries: [
        entry("/", ["Hero"]),
        entry("/fw-core", ["Hero"]),
        entry("/pricing", ["Hero", "Signup"]),
        entry("/about", ["Signup"]),
      ],
      ranking: [],
    }),
  ).toThrow(
    new ConfigError(
      [
        "Chunk tiers: 1 chunk group name is also an entry name — report it upstream with the names below: the framework mints both entry names and tier group names, so no site setting can separate them:",
        '  "fw-core" — en /fw-core',
      ].join("\n"),
    ),
  );
});

test("every page claiming a group name is named", () => {
  expect(() =>
    planTiers({
      entries: [
        entry("/fw-core", ["Hero", "Signup"]),
        entry("/fw-mid", ["Hero", "Signup"]),
        entry("/a", ["Hero"]),
        entry("/b", ["Hero"]),
        entry("/c", ["Hero"]),
      ],
      ranking: [],
    }),
  ).toThrow(
    new ConfigError(
      [
        "Chunk tiers: 2 chunk group names are also entry names — report it upstream with the names below: the framework mints both entry names and tier group names, so no site setting can separate them:",
        '  "fw-core" — en /fw-core',
        '  "fw-mid" — en /fw-mid',
      ].join("\n"),
    ),
  );
});

test("the tier plan serializes to the golden shape", () => {
  const plan = planTiers({
    entries: [
      entry("/", ["Hero", "Signup"], "@site/providers"),
      entry("/pricing", ["Hero", "Signup"]),
      entry("/about", ["Hero"]),
      entry("/blog", ["Hero"]),
      entry("/blog/one", ["Hero", "Chart"]),
    ],
    ranking: [
      ranked("Hero", 9, 5, 0),
      ranked("Signup", 3, 2, 6),
      ranked("Chart", 1, 1, 2),
    ],
  });

  expect(JSON.stringify(plan, null, 2)).toBe(
    [
      "{",
      `  "policy": {`,
      `    "coreMinShare": 0.6,`,
      `    "coreMinUsageShare": 0.25,`,
      `    "midMinPages": 2,`,
      `    "exclude": [],`,
      `    "minSize": 20000,`,
      `    "minShareCount": 1`,
      `  },`,
      `  "pageCount": 5,`,
      `  "shippedUsages": 13,`,
      `  "groups": [`,
      `    {`,
      `      "name": "fw-core",`,
      `      "priority": 30,`,
      `      "entriesAware": false,`,
      `      "minSize": 20000,`,
      `      "minShareCount": 1,`,
      `      "modules": [`,
      `        "@ds/Hero",`,
      `        "@pagedeck/islands/runtime",`,
      `        "@site/providers"`,
      `      ]`,
      `    },`,
      `    {`,
      `      "name": "fw-mid",`,
      `      "priority": 20,`,
      `      "entriesAware": true,`,
      `      "entriesAwareMergeThreshold": 20000,`,
      `      "minSize": 20000,`,
      `      "minShareCount": 1,`,
      `      "modules": [`,
      `        "@ds/Signup"`,
      `      ]`,
      `    }`,
      `  ],`,
      `  "assignments": [`,
      `    {`,
      `      "component": "Chart",`,
      `      "module": "@ds/Chart",`,
      `      "tier": "tail",`,
      `      "pageCount": 1,`,
      `      "pageShare": 0.2,`,
      `      "totalUsages": 1,`,
      `      "usageShare": 0.07692307692307693,`,
      `      "avgFoldScore": 2`,
      `    },`,
      `    {`,
      `      "component": "Hero",`,
      `      "module": "@ds/Hero",`,
      `      "tier": "core",`,
      `      "group": "fw-core",`,
      `      "pageCount": 5,`,
      `      "pageShare": 1,`,
      `      "totalUsages": 9,`,
      `      "usageShare": 0.6923076923076923,`,
      `      "avgFoldScore": 0`,
      `    },`,
      `    {`,
      `      "component": "Signup",`,
      `      "module": "@ds/Signup",`,
      `      "tier": "mid",`,
      `      "group": "fw-mid",`,
      `      "pageCount": 2,`,
      `      "pageShare": 0.4,`,
      `      "totalUsages": 3,`,
      `      "usageShare": 0.23076923076923078,`,
      `      "avgFoldScore": 6`,
      `    }`,
      `  ]`,
      "}",
    ].join("\n"),
  );
});

test("each group's test captures exactly the ids its modules resolve to", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });
  const config = codeSplitting(plan, {
    "@ds/Hero": "/site/ds/Hero.js",
    "@ds/Nav": "/site/ds/Nav.js",
    "@ds/Signup": "/site/ds/Signup.js",
    "@ds/Chart": "/site/ds/Chart.js",
    "@ds/Analytics": "/site/ds/Analytics.js",
    "@pagedeck/islands/runtime": "/pagedeck/runtime.js",
  });

  const core = config.groups.find((group) => group.name === "fw-core");
  const mid = config.groups.find((group) => group.name === "fw-mid");
  expect(core?.test("/site/ds/Hero.js")).toBe(true);
  expect(core?.test("/pagedeck/runtime.js")).toBe(true);
  expect(core?.test("/site/ds/Signup.js")).toBe(false);
  expect(mid?.test("/site/ds/Signup.js")).toBe(true);
  expect(mid?.test("/site/ds/Chart.js")).toBe(false);
  expect(core?.test("/site/ds/Hero.js.map")).toBe(false);
  expect(core?.test("/site/ds/HeroBanner.js")).toBe(false);
  expect(core?.test("/site/ds/Hero.js?v=1")).toBe(true);
});

test("the ids may arrive after the config was built", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });
  let ids: Record<string, string> = {};
  const config = codeSplitting(plan, () => ids);
  const core = config.groups.find((group) => group.name === "fw-core");

  ids = { "@ds/Hero": "/site/ds/Hero.js" };
  expect(core?.test("/site/ds/Hero.js")).toBe(true);

  ids = {};
  expect(core?.test("/site/ds/Hero.js")).toBe(true);
});

test("a grouped module with no bundler id is refused", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });

  expect(() => codeSplitting(plan, { "@ds/Hero": "/site/ds/Hero.js" })).toThrow(
    new ConfigError(
      [
        "Chunk tiers: 4 grouped modules have no bundler id — map each specifier to the id the bundler resolves it to, or drop the component from the pages that use it:",
        '  "@ds/Analytics" — grouped into "fw-core"',
        '  "@ds/Nav" — grouped into "fw-core"',
        '  "@pagedeck/islands/runtime" — grouped into "fw-core"',
        '  "@ds/Signup" — grouped into "fw-mid"',
      ].join("\n"),
    ),
  );

  expect(() =>
    assertModuleIds(plan, { "@ds/Hero": "/site/ds/Hero.js" }),
  ).toThrow(
    new ConfigError(
      [
        "Chunk tiers: 4 grouped modules have no bundler id — map each specifier to the id the bundler resolves it to, or drop the component from the pages that use it:",
        '  "@ds/Analytics" — grouped into "fw-core"',
        '  "@ds/Nav" — grouped into "fw-core"',
        '  "@pagedeck/islands/runtime" — grouped into "fw-core"',
        '  "@ds/Signup" — grouped into "fw-mid"',
      ].join("\n"),
    ),
  );
});

test("a module id read off the prototype is not an id", () => {
  const shady: PageEntry = {
    ...entry("/", ["Hero"]),
    components: [{ name: "Hero", module: "constructor", eager: true }],
  };
  const plan = planTiers({
    entries: [shady, { ...shady, path: "/pricing", name: "pricing" }],
    ranking: [],
  });

  expect(() =>
    codeSplitting(plan, { "@pagedeck/islands/runtime": "/pagedeck/runtime.js" }),
  ).toThrow(ConfigError);
  expect(() =>
    assertModuleIds(plan, { "@pagedeck/islands/runtime": "/pagedeck/runtime.js" }),
  ).toThrow(ConfigError);
});

test("the global fallbacks repeat the policy's guards", () => {
  const plan = planTiers({ entries: ENTRIES, ranking: RANKING });
  const config = codeSplitting(plan, {
    "@ds/Analytics": "/site/ds/Analytics.js",
    "@ds/Hero": "/site/ds/Hero.js",
    "@ds/Nav": "/site/ds/Nav.js",
    "@ds/Signup": "/site/ds/Signup.js",
    "@pagedeck/islands/runtime": "/pagedeck/runtime.js",
  });

  expect(config.minSize).toBe(DEFAULT_TIER_POLICY.minSize);
  expect(config.minShareCount).toBe(DEFAULT_TIER_POLICY.minShareCount);
});
