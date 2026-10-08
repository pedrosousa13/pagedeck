import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ASSET_DIR, buildClient, checkClientGraph } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { ManifestChunk } from "./manifest.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";
import type { TierPlan } from "./tiers.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-client-build-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

// Returned, not measured: oxc constant-folds a `.length` over a literal and drops it.
const FIXTURE: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-0f31"; }\n`,
  "Nav.js": `export default function Nav() { return "marker-nav-6ba4"; }\n`,
  "Chart.js": `export default function Chart() { return "marker-chart-c85d"; }\n`,
  "Card.tsx": `export default function Card() { return <div>marker-card-3e9a</div>; }\n`,
  "Unused.js": `export default function Unused() { return "marker-unused-77af"; }\n`,
  "shared.js": `export function caption(marker) { return \`\${marker} caption-5d0e\`; }\n`,
  "Faq.js": `import { caption } from "./shared.js";\nexport default function Faq() { return caption("marker-faq-61c4"); }\n`,
  "VirtualFaq.js": `import { caption } from "virtual:caption";\nexport default function Faq() { return caption("marker-faq-61c4"); }\n`,
  "VirtualSignup.js": `import { caption } from "virtual:caption";\nexport default function Signup() { return caption("marker-signup-8d2a"); }\n`,
  "Signup.js": `import { caption } from "./shared.js";\nexport default function Signup() { return caption("marker-signup-8d2a"); }\n`,
};

// Real directories: the copy check reads each id's `package.json` for the version
// and fails open when it cannot.
const HOISTED_COPY = `${FIXTURE_DIR}node_modules/@ds/store/`;
const NESTED_COPY = `${FIXTURE_DIR}node_modules/@ds/chart/node_modules/@ds/store/`;

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  for (const [file, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${file}`, source);
  }
  for (const copy of [HOISTED_COPY, NESTED_COPY]) {
    mkdirSync(copy, { recursive: true });
    writeFileSync(
      `${copy}package.json`,
      JSON.stringify({ name: "@ds/store", version: "1.0.0" }),
    );
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
  Card: "./src/Card.tsx",
};

const PAGES: readonly Page[] = [
  { locale: "en", path: "/", output: "/en", dependencies: [] },
  { locale: "en", path: "/pricing", output: "/en/pricing", dependencies: [] },
  { locale: "en", path: "/about", output: "/en/about", dependencies: [] },
];

const ISLANDS: Record<string, readonly string[]> = {
  "/": ["Hero", "Nav", "Card"],
  "/pricing": ["Hero", "Nav", "Card", "Chart"],
  "/about": [],
};

function demands(): readonly PageDemand[] {
  return PAGES.map((page) => ({
    page,
    islands: (ISLANDS[page.path] ?? []).map((component) => ({
      component,
      mode: "visible" as const,
    })),
  }));
}

function plan() {
  return planEntries(demands(), { modules: MODULES });
}

function entryOf(path: string): string {
  const found = plan().entries.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`no entry for ${path}`);
  return found.name;
}

const HOME = entryOf("/");
const PRICING = entryOf("/pricing");

// `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
// line each.
function tiers(entries: ReturnType<typeof plan>): TierPlan {
  return planTiers({
    entries: entries.entries,
    ranking: [],
    policy: { minSize: 0 },
  });
}

async function built(): Promise<ClientBuild> {
  const entries = plan();
  return await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    tiers: tiers(entries),
  });
}

function textOf(contents: string | Uint8Array): string {
  return typeof contents === "string"
    ? contents
    : new TextDecoder().decode(contents);
}

test("the core tier holds the modules the plan assigned it", async () => {
  const build = await built();

  const core = build.files.find((file) => file.name === "fw-core");
  expect(core).toBeDefined();
  const modules = build.modules.get(core?.path ?? "") ?? [];

  const runtime = build.ids["@pagedeck/islands/runtime"];
  expect(runtime).toMatch(/^\//);
  expect(modules).toContain(runtime);
  expect(modules).toContain(build.ids["./src/Hero.js"]);
  expect(modules).toContain(build.ids["./src/Nav.js"]);

  expect(textOf(core?.contents ?? "")).toContain("marker-hero-0f31");
  expect(textOf(core?.contents ?? "")).not.toContain("marker-chart-c85d");
}, 60_000);

test("a grouped specifier the bundler cannot resolve is reported once", async () => {
  const entries = plan();
  const planned = tiers(entries);
  const orphaned: TierPlan = {
    ...planned,
    groups: planned.groups.map((group) => ({
      ...group,
      modules: [...group.modules, "@ds/absent", "@ds/also-absent"],
    })),
  };

  await expect(
    buildClient({
      root: FIXTURE_DIR,
      origin: ORIGIN,
      plan: entries,
      tiers: orphaned,
    }),
  ).rejects.toThrow(
    new ConfigError(
      [
        `Client build: 2 grouped specifiers did not resolve — install the package, or fix the component's path or specifier in build.components:`,
        `  "@ds/absent" — resolved against "${ORIGIN}"`,
        `  "@ds/also-absent" — resolved against "${ORIGIN}"`,
      ].join("\n"),
    ),
  );
}, 60_000);

test("a component specifier the bundler cannot resolve fails the build", async () => {
  const entries = planEntries(
    [
      {
        page: PAGES[0] as Page,
        islands: [{ component: "Ghost", mode: "load" }],
      },
    ],
    { modules: { Ghost: "@ds/absent-component" } },
  );

  const failure = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    tiers: tiers(entries),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toBe(
    [
      `Client build: 1 component specifier did not resolve — install the package, or fix the component's path or specifier in build.components:`,
      `  "Ghost" — "@ds/absent-component" — imported by the entry for en /, resolved against "${ORIGIN}"`,
    ].join("\n"),
  );
  expect((failure as Error).message).not.toContain("external");

  const cause = (failure as Error).cause as Error | undefined;
  expect(cause?.message).toContain(
    'failed to resolve import "@ds/absent-component"',
  );
}, 60_000);

test("a fault a build hook raised outranks the unresolved-specifier report", async () => {
  writeFileSync(`${SRC}Broken.js`, `export default function Broken( { return 1;\n`);

  const entries = planEntries(
    [
      {
        page: PAGES[0] as Page,
        islands: [
          { component: "Broken", mode: "load" },
          { component: "Ghost", mode: "load" },
        ],
      },
    ],
    {
      modules: {
        Broken: "./src/Broken.js",
        Ghost: "@ds/absent-component",
      },
    },
  );

  const failure = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    tiers: tiers(entries),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).not.toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toContain("Broken.js");
  expect((failure as Error).message).not.toContain("@ds/absent-component");
}, 120_000);

test("two builds are byte-identical across differing NODE_ENV", async () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const one = await built();
    process.env.NODE_ENV = "production";
    const two = await built();

    expect(two.files.map((file) => file.path)).toEqual(
      one.files.map((file) => file.path),
    );
    for (const [index, file] of one.files.entries()) {
      expect(textOf(two.files[index]?.contents ?? "")).toBe(
        textOf(file.contents),
      );
    }
  } finally {
    process.env.NODE_ENV = before;
  }
}, 60_000);

test("no chunk carries a build-machine path or a sourcemap", async () => {
  const build = await built();

  for (const file of build.files) {
    const text = textOf(file.contents);
    expect(text).not.toContain(FIXTURE_DIR);
    expect(text).not.toContain("sourceMappingURL");
    expect(file.path.endsWith(".map")).toBe(false);
  }
  expect(
    build.files.some((file) => textOf(file.contents).includes("marker-card")),
  ).toBe(true);
}, 60_000);

test("a production build ships no development React", async () => {
  const build = await built();

  // A warning's text, not an identifier: minification renames identifiers and keeps
  // string literals.
  for (const file of build.files) {
    expect(textOf(file.contents)).not.toContain(
      "Each child in a list should have a unique",
    );
  }
}, 60_000);

test("every entry script is a file the build emitted", async () => {
  const build = await built();
  const paths = new Set(build.files.map((file) => file.path));

  expect(build.entryScripts.size).toBe(2);
  for (const [name, path] of build.entryScripts) {
    expect(paths.has(path)).toBe(true);
    expect(path.startsWith(`/${ASSET_DIR}/`)).toBe(true);
    expect(path).not.toContain(`/${ASSET_DIR}/${ASSET_DIR}/`);
    expect(path).not.toContain("//");
    expect(path.split("/").filter((segment) => segment === ASSET_DIR)).toEqual([
      ASSET_DIR,
    ]);
    expect(name).not.toBe("");
  }
}, 60_000);

test("a content-only page gets no chunk and no script", async () => {
  const build = await built();

  expect([...build.entryScripts.keys()].sort()).toEqual(
    [HOME, PRICING].sort(),
  );
  expect(plan().entries.map((entry) => entry.path)).not.toContain("/about");
}, 60_000);

test("a tier group that captured nothing fails the graph check", async () => {
  const entries = plan();
  const planned = tiers(entries);
  const orphaned: TierPlan = {
    ...planned,
    groups: [
      ...planned.groups,
      {
        name: "fw-orphan",
        priority: 10,
        entriesAware: false,
        minSize: 0,
        minShareCount: 1,
        modules: ["./src/Unused.js"],
      },
    ],
  };

  await expect(
    buildClient({
      root: FIXTURE_DIR,
      origin: ORIGIN,
      plan: entries,
      tiers: orphaned,
    }),
  ).rejects.toThrow(
    new ConfigError(
      [
        "Client build: 1 chunk tier captured no module — check the module map spells the tier's specifiers the way the pages import them:",
        '  "fw-orphan" — no module in the emitted graph matched it',
      ].join("\n"),
    ),
  );
}, 60_000);

test("a module in more than one chunk is reported by id", () => {
  const entries = plan();
  const planned = tiers(entries);

  expect(() =>
    checkClientGraph({
      plan: entries,
      tiers: planned,
      chunks: [
        {
          fileName: "assets/en-aaaa.js",
          name: HOME,
          isEntry: true,
          imports: [],
          modules: [`${SRC}Hero.js`, `${SRC}store.js`],
        },
        {
          fileName: "assets/en-pricing-bbbb.js",
          name: PRICING,
          isEntry: true,
          imports: [],
          modules: [`${SRC}Chart.js`, `${SRC}store.js`],
        },
      ],
      captured: new Set(planned.groups.map((group) => group.name)),
    }),
  ).toThrow(
    new ConfigError(
      [
        "Client build: 1 module came back in more than one chunk, so islands sharing it would get an instance each — report it upstream with the id below, and build on another Vite release to ship meanwhile, since the site's own configuration cannot cause this and cannot fix it:",
        `  "${SRC}store.js" — in assets/en-aaaa.js, assets/en-pricing-bbbb.js`,
      ].join("\n"),
    ),
  );
});

test("a page entry with no chunk of its own is reported", () => {
  const entries = plan();
  const planned = tiers(entries);

  expect(() =>
    checkClientGraph({
      plan: entries,
      tiers: planned,
      chunks: [
        {
          fileName: "assets/en-aaaa.js",
          name: HOME,
          isEntry: true,
          imports: [],
          modules: [`${SRC}Hero.js`],
        },
        {
          fileName: "assets/dup-bbbb.js",
          name: PRICING,
          isEntry: true,
          imports: [],
          modules: [`${SRC}Nav.js`],
        },
        {
          fileName: "assets/dup-cccc.js",
          name: PRICING,
          isEntry: true,
          imports: [],
          modules: [`${SRC}Chart.js`],
        },
      ],
      captured: new Set(planned.groups.map((group) => group.name)),
    }),
  ).toThrow(
    new ConfigError(
      [
        "Client build: 1 page entry did not come back as exactly one chunk — check that none of the site's build.vite.plugins emits, renames or drops a chunk under a generated entry's name:",
        `  "${PRICING}" — 2 entry chunks came back under that name, for en /pricing`,
      ].join("\n"),
    ),
  );
});

test("a chunk importing something the build did not emit fails the graph check", () => {
  const entries = plan();
  const planned = tiers(entries);

  expect(() =>
    checkClientGraph({
      plan: entries,
      tiers: planned,
      chunks: [
        {
          fileName: "assets/en-aaaa.js",
          name: HOME,
          isEntry: true,
          imports: ["assets/fw-core-cccc.js", "react"],
          modules: [`${SRC}Hero.js`],
        },
        {
          fileName: "assets/en-pricing-bbbb.js",
          name: PRICING,
          isEntry: true,
          imports: ["react", "https://cdn.example/chart.js?token=SECRET"],
          modules: [`${SRC}Chart.js`],
        },
        {
          fileName: "assets/fw-core-cccc.js",
          name: "fw-core",
          isEntry: false,
          imports: [],
          modules: [`${SRC}Nav.js`],
        },
      ],
      captured: new Set(planned.groups.map((group) => group.name)),
    }),
  ).toThrow(
    new ConfigError(
      [
        "Client build: 3 chunk imports do not name a chunk this build emitted, so a module outside the graph would be loaded on its own and the singleton guarantee would stop at this invocation — build the whole graph in one invocation, and externalize nothing:",
        '  "https://cdn.example/chart.js" — imported by assets/en-pricing-bbbb.js',
        '  "react" — imported by assets/en-aaaa.js',
        '  "react" — imported by assets/en-pricing-bbbb.js',
      ].join("\n"),
    ),
  );
});

test("two ids that are one module of one package under two node_modules are reported", () => {
  const entries = plan();
  const planned = tiers(entries);

  expect(() =>
    checkClientGraph({
      plan: entries,
      tiers: planned,
      chunks: [
        {
          fileName: "assets/en-aaaa.js",
          name: HOME,
          isEntry: true,
          imports: [],
          modules: [`${HOISTED_COPY}index.js`],
        },
        {
          fileName: "assets/en-pricing-bbbb.js",
          name: PRICING,
          isEntry: true,
          imports: [],
          modules: [`${NESTED_COPY}index.js`, `${SRC}Hero.js`],
        },
      ],
      captured: new Set(planned.groups.map((group) => group.name)),
    }),
  ).toThrow(
    new ConfigError(
      [
        "Client build: 1 module came back from more than one copy of its package at one version, so islands sharing it would get an instance each — install one copy of the package, by deduplicating the lockfile or hoisting it into the site's own dependencies:",
        `  "@ds/store/index.js" version 1.0.0 — at ${NESTED_COPY}index.js, ${HOISTED_COPY}index.js`,
      ].join("\n"),
    ),
  );
});

test("two colliding ids whose version cannot be read are not reported", () => {
  const entries = plan();
  const planned = tiers(entries);

  expect(() =>
    checkClientGraph({
      plan: entries,
      tiers: planned,
      chunks: [
        {
          fileName: "assets/en-aaaa.js",
          name: HOME,
          isEntry: true,
          imports: [],
          modules: ["/nowhere/node_modules/@ds/store/index.js"],
        },
        {
          fileName: "assets/en-pricing-bbbb.js",
          name: PRICING,
          isEntry: true,
          imports: [],
          modules: [
            "/nowhere/node_modules/@ds/chart/node_modules/@ds/store/index.js",
          ],
        },
      ],
      captured: new Set(planned.groups.map((group) => group.name)),
    }),
  ).not.toThrow();
});

test("a site that islands nothing builds, and builds nothing", async () => {
  const entries = planEntries(
    PAGES.map((page) => ({ page, islands: [] })),
    { modules: MODULES },
  );
  expect(entries.entries).toEqual([]);

  const build = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    tiers: tiers(entries),
  });

  expect(tiers(entries).groups.flatMap((group) => group.modules)).toEqual([
    "@pagedeck/islands/runtime",
  ]);

  expect(build.files).toEqual([]);
  expect(build.entryScripts.size).toBe(0);
  expect(build.modules.size).toBe(0);
  expect(build.ids).toEqual({});
});

test("a chunk's imports come back spelled the way its own path is", async () => {
  const build = await built();

  const entry = build.entryScripts.get(PRICING);
  expect(entry).toBeDefined();
  const reached = build.imports.get(entry ?? "") ?? [];
  expect(reached.length).toBeGreaterThan(0);

  const paths = new Set(build.files.map((file) => file.path));
  for (const one of build.imports.values()) {
    for (const target of one) expect(paths).toContain(target);
  }

  const startup = build.files.find((file) => file.name === "fw-startup");
  expect(reached).toContain(startup?.path);
}, 60_000);

test("a chunk's imports are the ones it fetches with itself, not the ones it may fetch later", async () => {
  const build = await built();

  const entry = build.entryScripts.get(PRICING) ?? "";
  const chart = build.files.find((file) => file.name === "Chart");
  expect(chart).toBeDefined();
  expect(build.imports.get(entry)).not.toContain(chart?.path);

  for (const one of build.imports.values()) {
    expect(one.length).toBe(new Set(one).size);
  }
}, 60_000);

test("every component specifier an entry imports resolves to an id a chunk holds", async () => {
  const build = await built();

  const held = new Map<string, string>();
  for (const [path, ids] of build.modules) {
    for (const id of ids) held.set(id, path);
  }
  for (const specifier of Object.values(MODULES)) {
    const id = build.ids[specifier];
    expect(id, specifier).toBeDefined();
    expect(held.get(id ?? ""), specifier).toBeDefined();
  }
  expect(held.get(build.ids["./src/Chart.js"] ?? "")).toBe(
    build.files.find((file) => file.name === "Chart")?.path,
  );
}, 60_000);


// Two pages whose islands share a module the site wrote, which no tier group
// claims, so Rolldown splits it by its own rules (#720).
const SHARING_MODULES = { Faq: "./src/Faq.js", Signup: "./src/Signup.js" };

function sharing(
  faq: string,
  modules: Record<string, string> = SHARING_MODULES,
): ReturnType<typeof plan> {
  return planEntries(
    [
      { page: PAGES[0] as Page, islands: [{ component: faq, mode: "visible" as const }] },
      { page: PAGES[1] as Page, islands: [{ component: "Signup", mode: "visible" as const }] },
    ],
    { modules },
  );
}

// The first build's tiers on every build, as an incremental build pins them.
async function builtSharing(
  faq: string,
  split?: Parameters<typeof buildClient>[0]["split"],
  modules: Record<string, string> = SHARING_MODULES,
): Promise<ClientBuild> {
  const entries = sharing(faq, modules);
  return await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: entries,
    tiers: planTiers({ entries: sharing("Faq", modules).entries, ranking: [] }),
    ...(split === undefined ? {} : { split }),
    plugins: [VIRTUAL_CAPTION],
  });
}

// A site plugin's module whose id is neither a path nor `\0`-prefixed.
const VIRTUAL_CAPTION = {
  name: "virtual-caption",
  resolveId: (source: string) => (source === "virtual:caption" ? source : undefined),
  load: (id: string) =>
    id === "virtual:caption"
      ? "export function caption(marker) { return `${marker} caption-5d0e`; }\n"
      : undefined,
};

function splitOf(build: ClientBuild): ManifestChunk[] {
  return build.files.flatMap((file) => (file.chunk === undefined ? [] : [file.chunk]));
}

test("a chunk no tier group made records the modules it holds, relative to the site root, and no other chunk does", async () => {
  const build = await builtSharing("Faq");

  expect(splitOf(build)).toEqual([{ name: "shared", modules: ["./src/shared.js"] }]);
}, 60_000);

test("a split handed back keeps each recorded chunk, so an island leaving the graph leaves the other page's chunks byte for byte", async () => {
  const first = await builtSharing("Faq");
  const signup = sharing("Faq").entries.find((entry) => entry.path === "/pricing")?.name ?? "";
  const kept = new Map(
    first.files.filter((file) => file.kind === "js").map((file) => [file.path, file.contents]),
  );

  const unpinned = await builtSharing("Signup");
  // The cause this guards against: left to Rolldown, the shared module joins
  // the one island still importing it and the entry is renamed.
  expect(unpinned.entryScripts.get(signup)).not.toBe(first.entryScripts.get(signup));

  const pinned = await builtSharing("Signup", splitOf(first));
  const entry = pinned.entryScripts.get(signup);
  expect(entry).toBe(first.entryScripts.get(signup));
  for (const file of pinned.files) {
    if (file.kind !== "js" || file.name === "Faq") continue;
    expect(kept.get(file.path), file.path).toEqual(file.contents);
  }
  expect(splitOf(pinned)).toEqual(splitOf(first));
}, 60_000);

test("a module a site plugin names without a path or a \\0 is pinned under the id it was recorded with", async () => {
  const modules = { Faq: "./src/VirtualFaq.js", Signup: "./src/VirtualSignup.js" };
  const first = await builtSharing("Faq", undefined, modules);
  expect(splitOf(first)).toEqual([{ name: "virtual_caption", modules: ["virtual:caption"] }]);
  const signup = sharing("Faq", modules).entries.find((entry) => entry.path === "/pricing")?.name ?? "";

  const pinned = await builtSharing("Signup", splitOf(first), modules);

  expect(pinned.entryScripts.get(signup)).toBe(first.entryScripts.get(signup));
}, 60_000);
