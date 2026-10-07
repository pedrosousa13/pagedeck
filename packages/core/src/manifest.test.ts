import { expect, test } from "vitest";
import { checkDrift } from "./drift.js";
import { planEntries } from "./entries.js";
import type { EntryPlan, PageDemand } from "./entries.js";
import { ConfigError } from "./exit.js";
import {
  buildManifest,
  deployKeyFault,
  deployKeyReport,
  fileKey,
  manifestJson,
  MANIFEST_VERSION,
  pathCollisionReport,
  readManifest,
} from "./manifest.js";
import type { BuildStamp, EmittedFile, ManifestInput } from "./manifest.js";
import type { Page } from "./pages.js";
import { planRouting } from "./routing.js";
import { planTiers } from "./tiers.js";

const MODULES = { Hero: "@ds/Hero", Chart: "@ds/Chart" };

const STAMP: BuildStamp = {
  id: "build-2026-08-25-01",
  createdAt: "2026-08-25T10:00:00.000Z",
};

const HOME: Page = {
  locale: "en",
  path: "/",
  output: "/en",
  collection: "pages",
  entry: { locale: "en", path: "home" },
  template: "HomePage",
  dependencies: [
    { collection: "pages", locale: "en", path: "home" },
    { collection: "globals", locale: "en", path: "nav" },
  ],
};

const ABOUT: Page = {
  locale: "en",
  path: "/about",
  output: "/en/about",
  dependencies: [],
};

function demand(page: Page, components: readonly string[]): PageDemand {
  return {
    page,
    islands: components.map((component) => ({
      component,
      mode: "visible" as const,
    })),
  };
}

function plan(demands: readonly PageDemand[]): EntryPlan {
  return planEntries(demands, { modules: MODULES });
}

function entryName(components: readonly string[]): string {
  return plan([demand(ABOUT, components)]).entries[0]?.name ?? "";
}

const HERO = entryName(["Hero"]);

const OUTPUTS: readonly EmittedFile[] = [
  {
    path: "/en/index.html",
    kind: "html",
    page: { locale: "en", path: "/" },
    contents: "<!doctype html><title>Home</title>",
  },
  {
    path: "/en/about/index.html",
    kind: "html",
    page: { locale: "en", path: "/about" },
    contents: "<!doctype html><title>About</title>",
  },
  {
    path: "/assets/en-a1b2c3.js",
    kind: "js",
    name: HERO,
    contents: 'import "./fw-core-d4e5f6.js";',
  },
  {
    path: "/assets/fw-core-d4e5f6.js",
    kind: "js",
    name: "fw-core",
    contents: "export const runtime = 1;",
  },
  {
    path: "/assets/core-1a2b3c.css",
    kind: "css",
    contents: ".bg-white{background:#fff}",
  },
  {
    path: "/media/logo-7f8e9d.svg",
    kind: "asset",
    contents: new Uint8Array([60, 115, 118, 103, 47, 62]),
  },
];

const ROUTING = planRouting({
  pages: [HOME, ABOUT],
  trailingSlash: "never",
  config: {
    redirects: [{ from: "/en/legacy", to: "/en/about", status: 301 }],
    notFound: [{ locale: "en", path: "/about" }],
    headers: [
      {
        prefix: "/en",
        set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
      },
    ],
  },
});

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  const entries =
    overrides.entries ?? plan([demand(HOME, ["Hero"]), demand(ABOUT, [])]);
  return {
    build: STAMP,
    store: { seq: 512 },
    site: { trailingSlash: "never" },
    routing: ROUTING,
    pages: [HOME, ABOUT],
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: ["bg-white"],
    foldTuning: new Map(),
    outputs: OUTPUTS,
    ...overrides,
    entries,
  };
}

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, but it returned");
}

test("the manifest serializes to the golden shape", () => {
  expect(manifestJson(buildManifest(input()))).toBe(
    [
      "{",
      `  "version": 11,`,
      `  "build": {`,
      `    "id": "build-2026-08-25-01",`,
      `    "createdAt": "2026-08-25T10:00:00.000Z"`,
      `  },`,
      `  "store": {`,
      `    "seq": 512`,
      `  },`,
      `  "site": {`,
      `    "trailingSlash": "never"`,
      `  },`,
      `  "routing": {`,
      `    "version": 1,`,
      `    "site": {`,
      `      "trailingSlash": "never"`,
      `    },`,
      `    "trees": [`,
      `      {`,
      `        "redirects": [`,
      `          {`,
      `            "from": "/en/legacy",`,
      `            "to": "/en/about",`,
      `            "status": 301,`,
      `            "source": "config",`,
      `            "via": []`,
      `          }`,
      `        ],`,
      `        "notFound": "/en/about",`,
      `        "headers": [`,
      `          {`,
      `            "prefix": "/en",`,
      `            "set": [`,
      `              {`,
      `                "name": "X-Content-Type-Options",`,
      `                "value": "nosniff"`,
      `              }`,
      `            ]`,
      `          }`,
      `        ]`,
      `      }`,
      `    ]`,
      `  },`,
      `  "files": [`,
      `    {`,
      `      "path": "/assets/core-1a2b3c.css",`,
      `      "kind": "css",`,
      `      "hash": "sha256:68a857e89408336bfb91649f9bf68b1fda3cfe006af4c7873656ba5af375c2c0",`,
      `      "size": 26`,
      `    },`,
      `    {`,
      `      "path": "/assets/en-a1b2c3.js",`,
      `      "kind": "js",`,
      `      "hash": "sha256:d061e1b7aef010da1b64d15e19f50018e7c723ccad63eb8a44c7f0075eb3e7c5",`,
      `      "size": 29`,
      `    },`,
      `    {`,
      `      "path": "/assets/fw-core-d4e5f6.js",`,
      `      "kind": "js",`,
      `      "hash": "sha256:d926316c95295321b148a6f1748a181d400de61b333988d1c5cf9f93eb7a8006",`,
      `      "size": 25`,
      `    },`,
      `    {`,
      `      "path": "/en/about/index.html",`,
      `      "kind": "html",`,
      `      "hash": "sha256:a773a66efb1af5383c8ad6bda34fc40bb069183eb763454ae89c8b4512c234e3",`,
      `      "size": 35`,
      `    },`,
      `    {`,
      `      "path": "/en/index.html",`,
      `      "kind": "html",`,
      `      "hash": "sha256:7ee4143a47c59fa2b1f79d25a12c269f433622af257b724fa70a5595f2dce8b3",`,
      `      "size": 34`,
      `    },`,
      `    {`,
      `      "path": "/media/logo-7f8e9d.svg",`,
      `      "kind": "asset",`,
      `      "hash": "sha256:d4dc56669143034f31aa309635d4113d9ad76a02b1739da22c965ed2049be9e6",`,
      `      "size": 6`,
      `    }`,
      `  ],`,
      `  "pages": [`,
      `    {`,
      `      "locale": "en",`,
      `      "path": "/",`,
      `      "output": "/en",`,
      `      "collection": "pages",`,
      `      "entry": {`,
      `        "locale": "en",`,
      `        "path": "home"`,
      `      },`,
      `      "template": "HomePage",`,
      `      "dependencies": [`,
      `        {`,
      `          "collection": "pages",`,
      `          "locale": "en",`,
      `          "path": "home"`,
      `        },`,
      `        {`,
      `          "collection": "globals",`,
      `          "locale": "en",`,
      `          "path": "nav"`,
      `        }`,
      `      ],`,
      `      "html": "/en/index.html",`,
      `      "components": [`,
      `        {`,
      `          "name": "Hero",`,
      `          "module": "@ds/Hero",`,
      `          "eager": false`,
      `        }`,
      `      ],`,
      `      "entryChunk": "/assets/en-a1b2c3.js",`,
      `      "foldTuning": []`,
      `    },`,
      `    {`,
      `      "locale": "en",`,
      `      "path": "/about",`,
      `      "output": "/en/about",`,
      `      "dependencies": [],`,
      `      "html": "/en/about/index.html",`,
      `      "components": [],`,
      `      "foldTuning": []`,
      `    }`,
      `  ],`,
      `  "tiers": {`,
      `    "policy": {`,
      `      "coreMinShare": 0.6,`,
      `      "coreMinUsageShare": 0.25,`,
      `      "midMinPages": 2,`,
      `      "exclude": [],`,
      `      "minSize": 20000,`,
      `      "minShareCount": 1`,
      `    },`,
      `    "pageCount": 1,`,
      `    "shippedUsages": 0,`,
      `    "groups": [`,
      `      {`,
      `        "name": "fw-core",`,
      `        "priority": 30,`,
      `        "entriesAware": false,`,
      `        "minSize": 20000,`,
      `        "minShareCount": 1,`,
      `        "modules": [`,
      `          "@ds/Hero",`,
      `          "@pagedeck/islands/runtime"`,
      `        ]`,
      `      }`,
      `    ],`,
      `    "assignments": [`,
      `      {`,
      `        "component": "Hero",`,
      `        "module": "@ds/Hero",`,
      `        "tier": "core",`,
      `        "group": "fw-core",`,
      `        "pageCount": 1,`,
      `        "pageShare": 1,`,
      `        "totalUsages": 0,`,
      `        "usageShare": 0,`,
      `        "avgFoldScore": 0`,
      `      }`,
      `    ]`,
      `  },`,
      `  "classes": [`,
      `    "bg-white"`,
      `  ]`,
      "}",
      "",
    ].join("\n"),
  );
});

test("the class manifest is an array whether or not anything filled it", () => {
  expect(buildManifest(input({ classes: [] })).classes).toEqual([]);
  expect(
    buildManifest(input({ classes: ["text-sm", "bg-white", "text-sm"] }))
      .classes,
  ).toEqual(["bg-white", "text-sm"]);
});

test("a full rebuild request survives the document it is written into", () => {
  const request = checkDrift({
    pinned: ["bg-white"],
    rendered: [
      { affected: { page: HOME, reasons: [] }, html: '<i class="a"></i>' },
      { affected: { page: ABOUT, reasons: [] }, html: '<i class="b"></i>' },
    ],
    threshold: 1,
  }).fullRebuild;

  const manifest = buildManifest(input({ fullRebuild: request }));
  const read = readManifest(manifestJson(manifest), "/dist/manifest.json");

  expect(read.fullRebuild).toEqual({
    reason: "class-drift",
    drifted: 2,
    threshold: 1,
  });
  expect(manifestJson(manifest)).toContain(
    [
      `  "classes": [`,
      `    "bg-white"`,
      `  ],`,
      `  "fullRebuild": {`,
      `    "reason": "class-drift",`,
      `    "drifted": 2,`,
      `    "threshold": 1`,
      `  }`,
      "}",
      "",
    ].join("\n"),
  );
});

test("a build that asks for no rebuild writes no request", () => {
  const manifest = buildManifest(input());

  expect(manifest.fullRebuild).toBeUndefined();
  expect(manifestJson(manifest)).not.toContain("fullRebuild");
  expect(
    readManifest(manifestJson(manifest), "/dist/manifest.json").fullRebuild,
  ).toBeUndefined();
});

test("a build records the manifest it was based on, immediately after the clock reading", () => {
  const manifest = buildManifest(
    input({ build: { ...STAMP, parent: "build-2026-08-24-09" } }),
  );

  expect(manifestJson(manifest)).toContain(
    [
      `  "build": {`,
      `    "id": "build-2026-08-25-01",`,
      `    "createdAt": "2026-08-25T10:00:00.000Z",`,
      `    "parent": "build-2026-08-24-09"`,
      `  },`,
    ].join("\n"),
  );
  expect(
    readManifest(manifestJson(manifest), "/dist/manifest.json").build.parent,
  ).toBe("build-2026-08-24-09");
});

test("a build that found an empty retention store writes no parent", () => {
  const manifest = buildManifest(input());

  expect(manifest.build.parent).toBeUndefined();
  expect(manifestJson(manifest)).not.toContain("parent");
});

test("two builds of one site differ only in their build stamp", () => {
  const first = buildManifest(input());
  const second = buildManifest(
    input({
      build: {
        id: "build-2026-08-25-02",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    }),
  );

  expect(second.build).not.toEqual(first.build);
  expect(manifestJson({ ...second, build: first.build })).toBe(
    manifestJson(first),
  );
});

test("a manifest round-trips through its own reader", () => {
  const manifest = buildManifest(input());

  expect(readManifest(manifestJson(manifest), "/dist/manifest.json")).toEqual(
    manifest,
  );
});

test("a manifest this build cannot read is refused by version", () => {
  const ahead = manifestJson({
    ...buildManifest(input()),
    version: MANIFEST_VERSION + 1,
  });

  const failure = failureOf(() => readManifest(ahead, "/dist/manifest.json"));
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Manifest "/dist/manifest.json": is version 12, and this build reads version 11 — upgrade pagedeck, or read a manifest this version wrote',
  );

  const behind = manifestJson({ ...buildManifest(input()), version: 10 });
  expect(
    failureOf(() => readManifest(behind, "/dist/manifest.json")).message,
  ).toBe(
    'Manifest "/dist/manifest.json": is version 10, and this build reads version 11 — upgrade pagedeck, or read a manifest this version wrote',
  );
});

test("a build with nothing to route still writes the section", () => {
  const empty = planRouting({ pages: [HOME, ABOUT], trailingSlash: "never" });
  expect(buildManifest(input({ routing: empty })).routing).toEqual({
    version: 1,
    site: { trailingSlash: "never" },
    trees: [{ redirects: [], headers: [] }],
  });
});

test("a manifest that is not a manifest is refused before it is trusted", () => {
  expect(
    failureOf(() => readManifest("{", "/dist/manifest.json")).message,
  ).toBe(
    'Manifest "/dist/manifest.json": is not valid JSON — pagedeck build writes it, so re-run the build that produced it',
  );
  expect(
    failureOf(() => readManifest("{}", "/dist/manifest.json")).message,
  ).toBe(
    'Manifest "/dist/manifest.json": declares no version — every manifest pagedeck build writes has one, so re-run the build that produced it',
  );
});

function everyColumn(): Record<string, unknown> {
  const doc = JSON.parse(manifestJson(buildManifest(input()))) as {
    build: Record<string, unknown>;
    routing: { trees: Record<string, unknown>[] };
    files: Record<string, unknown>[];
    pages: Record<string, unknown>[];
  } & Record<string, unknown>;
  doc.build.parent = "build-2026-08-24-01";
  doc.fullRebuild = { reason: "class-drift", drifted: 3, threshold: 2 };
  doc.routing.trees.push({
    domain: "de.example",
    redirects: [],
    headers: [],
    experiments: [
      {
        path: "/pricing",
        cookie: "fw-pricing",
        variants: [{ name: "b", weight: 50 }],
      },
    ],
  });
  doc.files[0] = {
    domain: "de.example",
    ...doc.files[0],
    search: "pagefind",
    hashed: true,
    fontPages: ["/features"],
    chunk: { name: "shared", modules: ["./components/shared.ts"] },
  };
  doc.pages[0] = {
    ...doc.pages[0],
    domain: "de.example",
    fallbackFrom: "de",
    providers: "@ds/Providers",
    foldTuning: [
      { component: "Hero", position: 0, from: "visible", to: "load" },
    ],
    variants: [{ name: "b", html: "/_v/b/en/index.html" }],
    inlineScriptHashes: ["'sha256-abc='"],
  };
  return doc;
}

const ABSENT = Symbol("absent");
function edited(path: readonly (string | number)[], value: unknown): string {
  const doc = everyColumn();
  let at: Record<string | number, unknown> = doc;
  for (const key of path.slice(0, -1)) {
    at = at[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1] as string | number;
  if (value === ABSENT) delete at[last];
  else at[last] = value;
  return JSON.stringify(doc);
}

function malformed(...faults: readonly string[]): string {
  const count = faults.length;
  return `Manifest "/dist/manifest.json": ${String(count)} ${count === 1 ? "field does" : "fields do"} not hold what pagedeck build writes there (${faults.join("; ")}), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`;
}

test("a manifest of this version with every optional column filled still parses", () => {
  const text = JSON.stringify(everyColumn());

  expect(readManifest(text, "/dist/manifest.json")).toEqual(JSON.parse(text));
});

test.each<[string, readonly (string | number)[], unknown, string]>([
  ["build", ["build"], ABSENT, "build: expected an object, found nothing"],
  ["build.id", ["build", "id"], 7, "build.id: expected a string, found a number"],
  ["build.createdAt", ["build", "createdAt"], ABSENT, "build.createdAt: expected a string, found nothing"],
  ["build.parent", ["build", "parent"], null, "build.parent: expected a string or nothing, found null"],
  ["store", ["store"], ABSENT, "store: expected an object, found nothing"],
  ["store.seq", ["store", "seq"], "512", "store.seq: expected a number, found a string"],
  ["site.trailingSlash", ["site", "trailingSlash"], ABSENT, "site.trailingSlash: expected a string, found nothing"],
  ["routing", ["routing"], ABSENT, "routing: expected an object, found nothing"],
  ["routing.version", ["routing", "version"], ABSENT, "routing.version: expected a number, found nothing"],
  ["routing.trees", ["routing", "trees"], {}, "routing.trees: expected a list, found an object"],
  ["a redirect's from", ["routing", "trees", 0, "redirects", 0, "from"], ABSENT, "routing.trees[0].redirects[0].from: expected a string, found nothing"],
  ["a redirect's via", ["routing", "trees", 0, "redirects", 0, "via"], ABSENT, "routing.trees[0].redirects[0].via: expected a list, found nothing"],
  ["a redirect's file", ["routing", "trees", 0, "redirects", 0, "file"], false, "routing.trees[0].redirects[0].file: expected true or nothing, found false"],
  ["a header's value", ["routing", "trees", 0, "headers", 0, "set", 0, "value"], ABSENT, "routing.trees[0].headers[0].set[0].value: expected a string, found nothing"],
  ["a split's weight", ["routing", "trees", 1, "experiments", 0, "variants", 0, "weight"], "50", "routing.trees[1].experiments[0].variants[0].weight: expected a number, found a string"],
  ["files", ["files"], ABSENT, "files: expected a list, found nothing"],
  ["a files row", ["files", 0], null, "files[0]: expected an object, found null"],
  ["a file's path", ["files", 0, "path"], ABSENT, "files[0].path: expected a string, found nothing"],
  ["a file's domain", ["files", 0, "domain"], 1, "files[0].domain: expected a string or nothing, found a number"],
  ["a file's kind", ["files", 0, "kind"], ABSENT, "files[0].kind: expected a string, found nothing"],
  ["a file's hash", ["files", 0, "hash"], ABSENT, "files[0].hash: expected a string, found nothing"],
  ["a file's size", ["files", 0, "size"], "1", "files[0].size: expected a number, found a string"],
  ["a file's search", ["files", 0, "search"], true, "files[0].search: expected a string or nothing, found a boolean"],
  ["a file's hashed", ["files", 0, "hashed"], false, "files[0].hashed: expected true or nothing, found false"],
  ["a file's hashed as text", ["files", 0, "hashed"], "true", "files[0].hashed: expected true or nothing, found a string"],
  ["a file's fontPages", ["files", 0, "fontPages"], "/features", "files[0].fontPages: expected a list or nothing, found a string"],
  ["a file's font page pattern", ["files", 0, "fontPages", 0], 1, "files[0].fontPages[0]: expected a string, found a number"],
  ["a file's chunk", ["files", 0, "chunk"], "shared", "files[0].chunk: expected an object or nothing, found a string"],
  ["a file's chunk name", ["files", 0, "chunk", "name"], ABSENT, "files[0].chunk.name: expected a string, found nothing"],
  ["a file's chunk module", ["files", 0, "chunk", "modules", 0], 1, "files[0].chunk.modules[0]: expected a string, found a number"],
  ["pages", ["pages"], ABSENT, "pages: expected a list, found nothing"],
  ["a page's locale", ["pages", 1, "locale"], ABSENT, "pages[1].locale: expected a string, found nothing"],
  ["a page's path", ["pages", 1, "path"], ABSENT, "pages[1].path: expected a string, found nothing"],
  ["a page's output", ["pages", 1, "output"], ABSENT, "pages[1].output: expected a string, found nothing"],
  ["a page's html", ["pages", 1, "html"], ABSENT, "pages[1].html: expected a string, found nothing"],
  ["a page's collection", ["pages", 0, "collection"], 1, "pages[0].collection: expected a string or nothing, found a number"],
  ["a page's entry", ["pages", 0, "entry"], "home", "pages[0].entry: expected an object or nothing, found a string"],
  ["a page's entry path", ["pages", 0, "entry", "path"], ABSENT, "pages[0].entry.path: expected a string, found nothing"],
  ["a page's fallbackFrom", ["pages", 0, "fallbackFrom"], [], "pages[0].fallbackFrom: expected a string or nothing, found a list"],
  ["a page's dependencies", ["pages", 0, "dependencies"], ABSENT, "pages[0].dependencies: expected a list, found nothing"],
  ["a dependency's collection", ["pages", 0, "dependencies", 1, "collection"], ABSENT, "pages[0].dependencies[1].collection: expected a string, found nothing"],
  ["a page's components", ["pages", 0, "components"], ABSENT, "pages[0].components: expected a list, found nothing"],
  ["a component's eager", ["pages", 0, "components", 0, "eager"], "true", "pages[0].components[0].eager: expected a boolean, found a string"],
  ["a page's entryChunk", ["pages", 0, "entryChunk"], 0, "pages[0].entryChunk: expected a string or nothing, found a number"],
  ["a page's foldTuning", ["pages", 1, "foldTuning"], ABSENT, "pages[1].foldTuning: expected a list, found nothing"],
  ["a fold adjustment's position", ["pages", 0, "foldTuning", 0, "position"], ABSENT, "pages[0].foldTuning[0].position: expected a number, found nothing"],
  ["a variant's html", ["pages", 0, "variants", 0, "html"], ABSENT, "pages[0].variants[0].html: expected a string, found nothing"],
  ["an inline script hash", ["pages", 0, "inlineScriptHashes", 0], 1, "pages[0].inlineScriptHashes[0]: expected a string, found a number"],
  ["tiers", ["tiers"], ABSENT, "tiers: expected an object, found nothing"],
  ["tiers.groups", ["tiers", "groups"], ABSENT, "tiers.groups: expected a list, found nothing"],
  ["a tier group's modules", ["tiers", "groups", 0, "modules"], ABSENT, "tiers.groups[0].modules: expected a list, found nothing"],
  ["a tier assignment's component", ["tiers", "assignments", 0, "component"], ABSENT, "tiers.assignments[0].component: expected a string, found nothing"],
  ["tiers.policy.exclude", ["tiers", "policy", "exclude"], ABSENT, "tiers.policy.exclude: expected a list, found nothing"],
  ["classes", ["classes"], ABSENT, "classes: expected a list, found nothing"],
  ["a class", ["classes", 0], 1, "classes[0]: expected a string, found a number"],
  ["fullRebuild.drifted", ["fullRebuild", "drifted"], "3", "fullRebuild.drifted: expected a number, found a string"],
])(
  "a manifest of this version whose %s is not what pagedeck build writes is refused, naming the field",
  (_, path, value, line) => {
    const failure = failureOf(() =>
      readManifest(edited(path, value), "/dist/manifest.json"),
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(malformed(line));
  },
);

test("every malformed field of one manifest is named in one refusal", () => {
  const doc = everyColumn() as {
    tiers: Record<string, unknown>;
    files: Record<string, unknown>[];
  } & Record<string, unknown>;
  delete doc.store;
  delete doc.tiers.groups;
  delete doc.files[1]?.hash;

  expect(
    failureOf(() => readManifest(JSON.stringify(doc), "/dist/manifest.json"))
      .message,
  ).toBe(
    malformed(
      "store: expected an object, found nothing",
      "files[1].hash: expected a string, found nothing",
      "tiers.groups: expected a list, found nothing",
    ),
  );
});

test("a page's dependencies reach the manifest own-entry-first", () => {
  expect(buildManifest(input()).pages[0]?.dependencies).toEqual(
    HOME.dependencies,
  );
});

test("a fallback page records the locale that supplied it, and a native page none", () => {
  const fallback: Page = { ...HOME, fallbackFrom: "de" };
  const manifest = buildManifest(
    input({
      pages: [fallback, ABOUT],
      entries: plan([demand(fallback, ["Hero"]), demand(ABOUT, [])]),
    }),
  );

  expect(
    manifest.pages.map((page) => [page.path, page.fallbackFrom]),
  ).toEqual([
    ["/", "de"],
    ["/about", undefined],
  ]);
  expect(manifestJson(manifest)).toContain('      "fallbackFrom": "de",\n');
});

test("two locales on two domains keep their trees apart", () => {
  const de: Page = {
    locale: "de",
    path: "/preise",
    domain: "de.example",
    output: "/preise",
    dependencies: [],
  };
  const en: Page = {
    locale: "en",
    path: "/pricing",
    output: "/pricing",
    dependencies: [],
  };
  const entries = plan([demand(de, ["Hero"]), demand(en, ["Hero"])]);
  const manifest = buildManifest(
    input({
      pages: [de, en],
      entries,
      tiers: planTiers({ entries: entries.entries, ranking: [] }),
      outputs: [
        {
          domain: "de.example",
          path: "/preise/index.html",
          kind: "html",
          page: { locale: "de", path: "/preise" },
          contents: "de",
        },
        {
          domain: "de.example",
          path: "/assets/preise.js",
          kind: "js",
          name: HERO,
          contents: "de-entry",
        },
        {
          path: "/pricing/index.html",
          kind: "html",
          page: { locale: "en", path: "/pricing" },
          contents: "en",
        },
        {
          path: "/assets/pricing.js",
          kind: "js",
          name: HERO,
          contents: "en-entry",
        },
      ],
    }),
  );

  expect(manifest.files.map((file) => [file.domain, file.path])).toEqual([
    [undefined, "/assets/pricing.js"],
    [undefined, "/pricing/index.html"],
    ["de.example", "/assets/preise.js"],
    ["de.example", "/preise/index.html"],
  ]);
  expect(manifest.pages.map((page) => [page.domain, page.html])).toEqual([
    ["de.example", "//de.example/preise/index.html"],
    [undefined, "/pricing/index.html"],
  ]);
  expect(manifest.pages.map((page) => page.entryChunk)).toEqual([
    "//de.example/assets/preise.js",
    "/assets/pricing.js",
  ]);
});

test("a deploy key is one spelling, whatever mints it", () => {
  expect(fileKey(undefined, "/index.html")).toBe("/index.html");
  expect(fileKey("shop.example", "/index.html")).toBe(
    "//shop.example/index.html",
  );
  expect(fileKey("", "/index.html")).toBe("/index.html");
});

test("a content-only page records no entry chunk and no components", () => {
  const manifest = buildManifest(input());
  const about = manifest.pages[1];

  expect(about?.components).toEqual([]);
  expect(about?.entryChunk).toBeUndefined();
  expect(
    manifest.pages.filter((page) => page.entryChunk !== undefined).length,
  ).toBe(1);
});

test("a page's variant documents are recorded on its own row, and a page with none gains no key", () => {
  const manifest = buildManifest(
    input({
      outputs: [
        ...OUTPUTS,
        {
          path: "/_v/b/en/index.html",
          kind: "html",
          contents: "<!doctype html><title>Home</title>",
        },
      ],
      variants: new Map([
        ["en /", [{ name: "b", html: "/_v/b/en/index.html" }]],
      ]),
    }),
  );

  expect(manifest.pages[0]?.variants).toEqual([
    { name: "b", html: "/_v/b/en/index.html" },
  ]);
  expect(Object.hasOwn(manifest.pages[1] as object, "variants")).toBe(false);
  expect(manifestJson(manifest)).toContain(
    [
      `      "foldTuning": [],`,
      `      "variants": [`,
      `        {`,
      `          "name": "b",`,
      `          "html": "/_v/b/en/index.html"`,
      `        }`,
      `      ]`,
    ].join("\n"),
  );
});

test("a page's inline script hashes are recorded on its own row, and a page with none gains no key", () => {
  const hash = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";
  const manifest = buildManifest(
    input({ inlineScriptHashes: new Map([["en /", [hash]]]) }),
  );

  expect(manifest.pages[0]?.inlineScriptHashes).toEqual([hash]);
  expect(Object.hasOwn(manifest.pages[1] as object, "inlineScriptHashes")).toBe(
    false,
  );
  expect(manifestJson(manifest)).toContain(
    [
      `      "foldTuning": [],`,
      `      "inlineScriptHashes": [`,
      `        "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"`,
      `      ]`,
      `    },`,
    ].join("\n"),
  );
});

test("a file the search adapter returned is recorded with the adapter's name, and no other file gains a key", () => {
  const manifest = buildManifest(
    input({
      search: {
        adapter: "@pagedeck/search",
        files: new Set([fileKey(undefined, "/media/logo-7f8e9d.svg")]),
      },
    }),
  );

  const logo = manifest.files.find((file) => file.path === "/media/logo-7f8e9d.svg");
  expect(logo?.search).toBe("@pagedeck/search");
  for (const file of manifest.files) {
    if (file !== logo) expect(Object.hasOwn(file, "search")).toBe(false);
  }
  expect(manifestJson(manifest)).toContain(
    [
      `      "size": 6,`,
      `      "search": "@pagedeck/search"`,
      `    }`,
    ].join("\n"),
  );
});

test("a file emitted as hashed is recorded as hashed, and no other file gains a key", () => {
  const manifest = buildManifest(
    input({
      outputs: OUTPUTS.map((file) =>
        file.path === "/media/logo-7f8e9d.svg" ? { ...file, hashed: true as const } : file,
      ),
    }),
  );

  const logo = manifest.files.find((file) => file.path === "/media/logo-7f8e9d.svg");
  expect(logo?.hashed).toBe(true);
  for (const file of manifest.files) {
    if (file !== logo) expect(Object.hasOwn(file, "hashed")).toBe(false);
  }
  expect(manifestJson(manifest)).toContain(
    [`      "size": 6,`, `      "hashed": true`, `    }`].join("\n"),
  );
});

test("a scoped font sheet records its page patterns, and no other file gains a key", () => {
  const manifest = buildManifest(
    input({
      outputs: OUTPUTS.map((file) =>
        file.path === "/media/logo-7f8e9d.svg"
          ? { ...file, fontPages: ["/features", "en:/blog/**"] }
          : file,
      ),
    }),
  );

  const sheet = manifest.files.find((file) => file.path === "/media/logo-7f8e9d.svg");
  expect(sheet?.fontPages).toEqual(["/features", "en:/blog/**"]);
  for (const file of manifest.files) {
    if (file !== sheet) expect(Object.hasOwn(file, "fontPages")).toBe(false);
  }
  const json = manifestJson(manifest);
  expect(json).toContain(
    [`      "size": 6,`, `      "fontPages": [`, `        "/features",`, `        "en:/blog/**"`, `      ]`, `    }`].join("\n"),
  );
  const read = readManifest(json, "/dist/manifest.json");
  expect(read.files.find((file) => file.path === sheet?.path)?.fontPages).toEqual([
    "/features",
    "en:/blog/**",
  ]);
});

test("a chunk Rolldown split off records its name and modules, and no other file gains a key", () => {
  const manifest = buildManifest(
    input({
      outputs: [
        ...OUTPUTS,
        {
          path: "/assets/shared-9f8e7d.js",
          kind: "js",
          name: "shared",
          chunk: { name: "shared", modules: ["./components/shared.ts", "./lib/caption.ts"] },
          contents: "export const caption = 1;",
        },
      ],
    }),
  );

  const shared = manifest.files.find((file) => file.path === "/assets/shared-9f8e7d.js");
  expect(shared?.chunk).toEqual({
    name: "shared",
    modules: ["./components/shared.ts", "./lib/caption.ts"],
  });
  for (const file of manifest.files) {
    if (file !== shared) expect(Object.hasOwn(file, "chunk")).toBe(false);
  }
  const json = manifestJson(manifest);
  expect(json).toContain(
    [
      `      "size": 25,`,
      `      "chunk": {`,
      `        "name": "shared",`,
      `        "modules": [`,
      `          "./components/shared.ts",`,
      `          "./lib/caption.ts"`,
      `        ]`,
      `      }`,
      `    }`,
    ].join("\n"),
  );
  expect(
    readManifest(json, "/dist/manifest.json").files.find((file) => file.path === shared?.path)?.chunk,
  ).toEqual(shared?.chunk);
});

test("two emitted files claiming one deploy key are named", () => {
  expect(
    failureOf(() =>
      buildManifest(
        input({
          outputs: [
            ...OUTPUTS,
            {
              path: "/en/index.html",
              kind: "html",
              page: { locale: "en", path: "/about" },
              contents: "second",
            },
            {
              path: "/assets/en-a1b2c3.js",
              kind: "js",
              name: "fw-core",
              contents: "second",
            },
          ],
        }),
      ),
    ).message,
  ).toBe(
    [
      "Build manifest: 2 deploy keys are claimed by more than one emitted file — emit each file once, or write them to distinct paths:",
      `  "/assets/en-a1b2c3.js" — js named "${HERO}", js named "fw-core"`,
      '  "/en/index.html" — html for en /, html for en /about',
    ].join("\n"),
  );
});

test("a file that is not HTML cannot stand in for a page's HTML", () => {
  expect(
    failureOf(() =>
      buildManifest(
        input({
          outputs: [
            ...OUTPUTS.filter((file) => file.page?.path !== "/"),
            {
              path: "/assets/en-extra-9z8y7x.js",
              kind: "js",
              page: { locale: "en", path: "/" },
              contents: "export const extra = 1;",
            },
          ],
        }),
      ),
    ).message,
  ).toBe(
    [
      "Build manifest: 1 emitted file is tagged with a page it cannot be the HTML of — tag only a page's own HTML file, in that page's output tree:",
      '  "/assets/en-extra-9z8y7x.js" — tagged en /, and its kind is js',
    ].join("\n"),
  );
});

test("a page's HTML has to land in that page's own output tree", () => {
  const de: Page = {
    locale: "de",
    path: "/",
    domain: "de.example",
    output: "/",
    dependencies: [],
  };
  const en: Page = { locale: "en", path: "/", output: "/en", dependencies: [] };
  const entries = plan([demand(de, []), demand(en, [])]);

  expect(
    failureOf(() =>
      buildManifest(
        input({
          pages: [de, en],
          entries,
          tiers: planTiers({ entries: entries.entries, ranking: [] }),
          outputs: [
            {
              path: "/index.html",
              kind: "html",
              page: { locale: "de", path: "/" },
              contents: "de",
            },
            {
              domain: "de.example",
              path: "/en/index.html",
              kind: "html",
              page: { locale: "en", path: "/" },
              contents: "en",
            },
          ],
        }),
      ),
    ).message,
  ).toBe(
    [
      "Build manifest: 2 emitted files are tagged with pages they cannot be the HTML of — tag only a page's own HTML file, in that page's output tree:",
      '  "//de.example/en/index.html" — tagged en /, and that page renders into the default tree',
      '  "/index.html" — tagged de /, and that page renders into the "de.example" tree',
    ].join("\n"),
  );
});

test("two emitted files claiming one page or one chunk name are named", () => {
  const contested: readonly EmittedFile[] = [
    ...OUTPUTS,
    {
      path: "/en/index-copy.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: "<!doctype html><title>Home</title>",
    },
    {
      path: "/assets/en-9z8y7x.js",
      kind: "js",
      name: HERO,
      contents: 'import "./fw-core-d4e5f6.js";',
    },
  ];
  const message = failureOf(() =>
    buildManifest(input({ outputs: contested })),
  ).message;

  expect(message).toBe(
    [
      "Build manifest: 2 claims are made by more than one emitted file — emit one HTML file per page and one chunk per bundler name in each output tree, or drop the extra copy:",
      `  chunk name "${HERO}" in the default tree — "/assets/en-9z8y7x.js", "/assets/en-a1b2c3.js"`,
      '  page en / — "/en/index-copy.html", "/en/index.html"',
    ].join("\n"),
  );
  expect(
    failureOf(() => buildManifest(input({ outputs: [...contested].reverse() })))
      .message,
  ).toBe(message);
});

test("one chunk name in two output trees is two files, not a contested claim", () => {
  const DE: Page = {
    locale: "de",
    path: "/",
    domain: "de.example",
    output: "/",
    dependencies: [],
  };
  const entries = plan([demand(HOME, ["Hero"]), demand(DE, ["Hero"])]);
  const core: EmittedFile = {
    path: "/assets/fw-core-d4e5f6.js",
    kind: "js",
    name: "fw-core",
    contents: "export const runtime = 1;",
  };
  const manifest = buildManifest(
    input({
      pages: [HOME, DE],
      entries,
      outputs: [
        {
          path: "/en/index.html",
          kind: "html",
          page: { locale: "en", path: "/" },
          contents: "<!doctype html><title>Home</title>",
        },
        {
          domain: "de.example",
          path: "/index.html",
          kind: "html",
          page: { locale: "de", path: "/" },
          contents: "<!doctype html><title>Startseite</title>",
        },
        {
          path: "/assets/en-a1b2c3.js",
          kind: "js",
          name: HERO,
          contents: 'import "./fw-core-d4e5f6.js";',
        },
        {
          domain: "de.example",
          path: "/assets/de.example/index-x1y2z3.js",
          kind: "js",
          name: HERO,
          contents: 'import "../fw-core-d4e5f6.js";',
        },
        core,
        { ...core, domain: "de.example" },
      ],
    }),
  );

  expect(
    manifest.files
      .filter((file) => file.path === core.path)
      .map((file) => file.domain),
  ).toEqual([undefined, "de.example"]);

  expect(
    manifest.pages.map((page) => [page.locale, page.entryChunk]),
  ).toEqual([
    ["en", "/assets/en-a1b2c3.js"],
    ["de", "//de.example/assets/de.example/index-x1y2z3.js"],
  ]);
});

test("a page that emitted no HTML is named", () => {
  expect(
    failureOf(() =>
      buildManifest(
        input({
          outputs: OUTPUTS.filter((file) => file.kind !== "html"),
        }),
      ),
    ).message,
  ).toBe(
    [
      "Build manifest: 2 pages emitted no HTML — emit a file for each page and tag it with the page it renders, or drop the page from the route table:",
      "  en /",
      "  en /about",
    ].join("\n"),
  );
});

test("a page the entry plan never saw is named", () => {
  expect(
    failureOf(() =>
      buildManifest(input({ entries: plan([demand(HOME, ["Hero"])]) })),
    ).message,
  ).toBe(
    [
      "Build manifest: 1 page is in neither the entry plan's entries nor its content-only pages — plan entries over the same pages the manifest is built from:",
      "  en /about",
    ].join("\n"),
  );
});

const MISSING_CHUNK =
  "place each page's entry chunk in that page's own output tree, harvest every chunk of the build, or check that the bundler's input names still match the entry plan";

test("an entry whose chunk was never emitted is named", () => {
  expect(
    failureOf(() =>
      buildManifest(
        input({ outputs: OUTPUTS.filter((file) => file.name !== HERO) }),
      ),
    ).message,
  ).toBe(
    [
      `Build manifest: 1 page entry matched no emitted chunk in its own output tree — ${MISSING_CHUNK}:`,
      `  en / — entry name "${HERO}", looked for in the default tree`,
    ].join("\n"),
  );
});

test("an entry chunk emitted into the wrong tree is named, with the tree it was looked for in", () => {
  const DE: Page = {
    locale: "de",
    path: "/",
    domain: "de.example",
    output: "/",
    dependencies: [],
  };
  const entries = plan([demand(HOME, ["Hero"]), demand(DE, ["Hero"])]);

  expect(
    failureOf(() =>
      buildManifest(
        input({
          pages: [HOME, DE],
          entries,
          outputs: [
            ...OUTPUTS,
            {
              domain: "de.example",
              path: "/index.html",
              kind: "html",
              page: { locale: "de", path: "/" },
              contents: "<!doctype html><title>Startseite</title>",
            },
          ],
        }),
      ),
    ).message,
  ).toBe(
    [
      `Build manifest: 1 page entry matched no emitted chunk in its own output tree — ${MISSING_CHUNK}:`,
      `  de / — entry name "${HERO}", looked for in the "de.example" tree`,
    ].join("\n"),
  );
});

function pageDocument(
  locale: string,
  path: `/${string}`,
  document: string,
  domain?: string,
): EmittedFile {
  return {
    ...(domain === undefined ? {} : { domain }),
    path: document,
    kind: "html",
    page: { locale, path },
    contents: "<!doctype html>",
  };
}

function emittedAsset(path: string, domain?: string): EmittedFile {
  return {
    ...(domain === undefined ? {} : { domain }),
    path,
    kind: "asset",
    contents: "bytes",
  };
}

const PATH_COLLISION_HEADLINE =
  "this build emits into the same tree — a path in an output tree holds a file or a directory, never both, so no page below can be written beside the file its line names; route each page below at another path, or move the file if it is a passthrough file:";

test("a page whose document is at an emitted file's path is refused, naming both (#622)", () => {
  expect(
    pathCollisionReport([
      pageDocument("en", "/about/", "/about/index.html"),
      emittedAsset("/about/index.html"),
    ]),
  ).toBe(
    [
      `Site build: 1 page document collides with a file ${PATH_COLLISION_HEADLINE}`,
      '  en /about/ — its document "/about/index.html" is where the build emits an asset file',
    ].join("\n"),
  );
});

test("a page whose document needs an emitted file's path as a directory is refused, naming both (#622)", () => {
  expect(
    pathCollisionReport([
      pageDocument("en", "/sitemap.xml/", "/sitemap.xml/index.html"),
      emittedAsset("/sitemap.xml"),
    ]),
  ).toBe(
    [
      `Site build: 1 page document collides with a file ${PATH_COLLISION_HEADLINE}`,
      '  en /sitemap.xml/ — its document "/sitemap.xml/index.html" needs "/sitemap.xml" as a directory, where the build emits an asset file',
    ].join("\n"),
  );
});

test("a page whose document is a directory an emitted file needs is refused, naming both (#622)", () => {
  expect(
    pathCollisionReport([
      pageDocument("en", "/about", "/about/index.html"),
      emittedAsset("/about/index.html/logo.png"),
    ]),
  ).toBe(
    [
      `Site build: 1 page document collides with a file ${PATH_COLLISION_HEADLINE}`,
      '  en /about — its document "/about/index.html" is a directory the build needs for the asset file "/about/index.html/logo.png"',
    ].join("\n"),
  );
});

test("a page and a file at one path in two output trees do not collide (#622)", () => {
  expect(
    pathCollisionReport([
      pageDocument("en", "/sitemap.xml/", "/sitemap.xml/index.html"),
      emittedAsset("/sitemap.xml", "example.de"),
      pageDocument("de", "/about", "/about/index.html", "example.de"),
      emittedAsset("/about/index.html"),
      emittedAsset("/about/index.html/logo.png"),
    ]),
  ).toBeUndefined();
});

test("a site with no collision gets no report, and a page's own subtree holds files freely (#622)", () => {
  expect(
    pathCollisionReport([
      pageDocument("en", "/", "/index.html"),
      pageDocument("en", "/about", "/about/index.html"),
      emittedAsset("/about/logo.png"),
      emittedAsset("/sitemap.xml"),
      emittedAsset("/robots.txt"),
    ]),
  ).toBeUndefined();
});

test("every collision is reported in one run, sorted, with the tree named on a domain tree's keys (#622)", () => {
  expect(
    pathCollisionReport([
      pageDocument("en", "/sitemap.xml/", "/sitemap.xml/index.html"),
      pageDocument("de", "/rss.xml/", "/rss.xml/index.html", "example.de"),
      emittedAsset("/sitemap.xml"),
      emittedAsset("/rss.xml", "example.de"),
    ]),
  ).toBe(
    [
      `Site build: 2 page documents collide with files ${PATH_COLLISION_HEADLINE}`,
      '  de /rss.xml/ — its document "//example.de/rss.xml/index.html" needs "//example.de/rss.xml" as a directory, where the build emits an asset file',
      '  en /sitemap.xml/ — its document "/sitemap.xml/index.html" needs "/sitemap.xml" as a directory, where the build emits an asset file',
    ].join("\n"),
  );
});

test("a deploy key with a dot or empty segment, a backslash or a NUL is named as one no build writes (#659)", () => {
  for (const key of ["/index.html", "/assets/app-a1b2c3.js", "//example.com/index.html", "/.well-known/security.txt", "/a.b/c..d"]) {
    expect(deployKeyFault(key), key).toBeUndefined();
  }
  for (const key of [
    "index.html",
    "/assets/../index.html",
    "/./index.html",
    "/..",
    "/a//b",
    "/a/",
    "///index.html",
    "//../index.html",
    "//./x",
    "/a\\..\\b",
    "/x\u0000y",
    "",
  ]) {
    expect(deployKeyFault(key), JSON.stringify(key)).toBe(
      'a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character',
    );
  }
});

test("a manifest whose routing tree names a domain that resolves elsewhere is refused where it is read (#669)", () => {
  const manifest = buildManifest(input());
  const trees = [
    ...manifest.routing.trees,
    { domain: "../../x", redirects: [], headers: [] },
    { domain: "shop.example", redirects: [], headers: [] },
  ];
  const text = JSON.stringify({ ...manifest, routing: { ...manifest.routing, trees } });
  const first = manifest.routing.trees.length;
  expect(() => readManifest(text, "/origin/.pagedeck/manifests/b0.json")).toThrow(
    new ConfigError(
      `Manifest "/origin/.pagedeck/manifests/b0.json": 1 field does not hold what pagedeck build writes there (routing.trees[${String(first)}].domain: expected a tree key whose deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "//../../x"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    ),
  );
});

test("a manifest whose file row names a key that resolves elsewhere is refused where it is read, by path or by domain (#659)", () => {
  const manifest = buildManifest(input());
  const rows = [
    ...manifest.files,
    { path: "/assets/../index.html", kind: "asset", hash: "0", size: 1 },
    { domain: "..", path: "/index.html", kind: "asset", hash: "0", size: 1 },
  ];
  const text = JSON.stringify({ ...manifest, files: rows });
  const first = manifest.files.length;
  expect(() => readManifest(text, "/origin/.pagedeck/manifests/b0.json")).toThrow(
    new ConfigError(
      `Manifest "/origin/.pagedeck/manifests/b0.json": 2 fields do not hold what pagedeck build writes there (files[${String(first)}]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "/assets/../index.html"; files[${String(first + 1)}]: expected a deploy key that starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, found "//../index.html"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    ),
  );
});

const CONTROL_KEY_RULE =
  'starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character';

test.each([
  ["CR", "\r", "\\r"],
  ["LF", "\n", "\\n"],
  ["ESC", "\u001b", "\\u001b"],
  ["DEL", "\u007f", "\\u007f"],
  ["U+0085", "\u0085", "\\u0085"],
])(
  "a manifest whose file row or routing tree key holds a %s is refused where it is read, the key escaped (#674)",
  (_name, control, escaped) => {
    const manifest = buildManifest(input());
    const rows = [...manifest.files, { path: `/a${control}b.html`, kind: "asset", hash: "0", size: 1 }];
    const trees = [...manifest.routing.trees, { domain: `x${control}.example`, redirects: [], headers: [] }];
    const text = JSON.stringify({ ...manifest, files: rows, routing: { ...manifest.routing, trees } });
    const error = failureOf(() => readManifest(text, "/origin/.pagedeck/manifests/b0.json"));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(
      `Manifest "/origin/.pagedeck/manifests/b0.json": 2 fields do not hold what pagedeck build writes there (files[${String(manifest.files.length)}]: expected a deploy key that ${CONTROL_KEY_RULE}, found "/a${escaped}b.html"; routing.trees[${String(manifest.routing.trees.length)}].domain: expected a tree key whose deploy key ${CONTROL_KEY_RULE}, found "//x${escaped}.example"), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one`,
    );
    expect(error.message).not.toContain(control);
  },
);

test("every C0 and C1 control character and DEL is a deploy key fault, and printable non-ASCII is not (#674)", () => {
  for (let code = 0; code <= 0xa0; code += 1) {
    const key = `/a${String.fromCharCode(code)}b`;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    expect(deployKeyFault(key), JSON.stringify(key)).toBe(
      control || code === 0x5c ? `a deploy key ${CONTROL_KEY_RULE}` : undefined,
    );
  }
});

test("every emitted file at a key a deploy refuses is named, by its source where it has one, in every tree (#674)", () => {
  const icon = emittedAsset("/Icon\r");
  const iconDe = emittedAsset("/Icon\r", "example.de");
  const composed = emittedAsset("search/index.json");
  expect(deployKeyReport([emittedAsset("/index.html"), emittedAsset("/café.txt")], new Map())).toBeUndefined();
  expect(
    deployKeyReport(
      [icon, emittedAsset("/index.html"), composed, iconDe],
      new Map([
        [icon, "/site/public/Icon\r"],
        [iconDe, "/site/public/Icon\r"],
      ]),
    ),
  ).toBe(
    [
      `Site build: 3 files are at a key a deploy refuses — a deploy key ${CONTROL_KEY_RULE}; rename or delete each:`,
      '  "//example.de/Icon\\r" — from "/site/public/Icon\\r"',
      '  "/Icon\\r" — from "/site/public/Icon\\r"',
      '  "search/index.json"',
    ].join("\n"),
  );
  expect(deployKeyReport([composed], new Map())).toBe(
    `Site build: 1 file is at a key a deploy refuses — a deploy key ${CONTROL_KEY_RULE}; rename or delete it:\n  "search/index.json"`,
  );
});

test("a manifest whose keys hold printable non-ASCII characters, as real builds write, is read (#674)", () => {
  const manifest = buildManifest(input());
  const rows = [
    ...manifest.files,
    { path: "/café/index.html", kind: "html", hash: "0", size: 1 },
    { path: "/日本/index.html", kind: "html", hash: "0", size: 1 },
    { domain: "xn--mnchen-3ya.de", path: "/über/straße.html", kind: "asset", hash: "0", size: 1 },
  ];
  const text = JSON.stringify({ ...manifest, files: rows });
  expect(readManifest(text, "/origin/.pagedeck/manifests/b0.json").files).toEqual(rows);
});
