import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import { mergeDemands, planIncremental } from "./incremental.js";
import { buildManifest } from "./manifest.js";
import type { EmittedFile, Manifest } from "./manifest.js";
import type { Page } from "./pages.js";
import { planRouting } from "./routing.js";
import { planTiers } from "./tiers.js";
import type { TierPlan } from "./tiers.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-singleton-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

// Its exports are called and returned, so neither tree shaking nor the minifier can
// drop the shared import.
const FIXTURE: Record<string, string> = {
  "store.js": `let count = 0;
export function bump() { count += 1; return count; }
export function read() { return count; }
`,
  "Hero.js": `import { bump } from "./store.js";
export default function Hero() { return "marker-hero-5c14" + String(bump()); }
`,
  "Chart.js": `import { read } from "./store.js";
export default function Chart() { return "marker-chart-9b70" + String(read()); }
`,
  "Nav.js": `export default function Nav() { return "marker-nav-31af"; }\n`,
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

function demand(
  path: `/${string}`,
  output: string,
  components: readonly string[],
): PageDemand {
  const entry = { locale: "en", path: output.slice(1) };
  const page: Page = {
    locale: "en",
    path,
    output,
    collection: "pages",
    entry,
    dependencies: [{ collection: "pages", ...entry }],
  };
  return {
    page,
    islands: components.map((component) => ({
      component,
      mode: "visible" as const,
    })),
  };
}

const DEMANDS: readonly PageDemand[] = [
  demand("/", "/en", ["Hero", "Nav"]),
  demand("/pricing", "/en/pricing", ["Hero", "Nav"]),
  demand("/about", "/en/about", ["Hero", "Nav"]),
  demand("/blog", "/en/blog", ["Hero", "Nav"]),
  demand("/careers", "/en/careers", ["Hero", "Nav", "Chart"]),
];

// `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
// line each.
function planned(demands: readonly PageDemand[]): TierPlan {
  const plan = planEntries(demands, { modules: MODULES });
  return planTiers({
    entries: plan.entries,
    ranking: [],
    policy: { minSize: 0 },
  });
}

async function built(
  demands: readonly PageDemand[] = DEMANDS,
  tiers?: TierPlan,
): Promise<ClientBuild> {
  const plan = planEntries(demands, { modules: MODULES });
  return await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: tiers ?? planned(demands),
  });
}

function chunksHolding(build: ClientBuild, id: string): string[] {
  return [...build.modules]
    .filter(([, ids]) => ids.includes(id))
    .map(([path]) => path);
}

function storeId(build: ClientBuild): string {
  const ids = new Set(
    [...build.modules.values()].flat().filter((id) => id.endsWith("/store.js")),
  );
  expect([...ids]).toEqual([`${SRC}store.js`]);
  return `${SRC}store.js`;
}

test("a module two tiers share is in exactly one chunk", async () => {
  const build = await built();
  const store = storeId(build);

  const core = build.files.find((file) => file.name === "fw-core");
  expect(core).toBeDefined();
  const coreIds = build.modules.get(core?.path ?? "") ?? [];
  expect(coreIds).toContain(`${SRC}Hero.js`);
  expect(coreIds).not.toContain(`${SRC}Chart.js`);
  expect(chunksHolding(build, `${SRC}Chart.js`)).toHaveLength(1);

  expect(chunksHolding(build, store)).toHaveLength(1);
}, 60_000);

test("no module in the whole graph is in two chunks", async () => {
  const build = await built();

  const duplicated = [...build.modules]
    .flatMap(([path, ids]) => ids.map((id) => ({ path, id })))
    .reduce<Map<string, string[]>>((seen, { path, id }) => {
      seen.set(id, [...(seen.get(id) ?? []), path]);
      return seen;
    }, new Map());

  expect(
    [...duplicated]
      .filter(([, paths]) => paths.length > 1)
      .map(([id, paths]) => `${id} in ${paths.join(", ")}`),
  ).toEqual([]);
  expect(duplicated.size).toBeGreaterThan(10);
}, 60_000);

// Every page needs HTML: a row without it reads back as `no-previous-render`, which
// re-renders the whole site.
function html(page: Page): EmittedFile {
  return {
    path: `${page.output}/index.html`,
    kind: "html",
    page: { locale: page.locale, path: page.path },
    contents: `<!doctype html><title>${page.path}</title>`,
  };
}

function manifestOf(build: ClientBuild, tiers: TierPlan): Manifest {
  const pages = DEMANDS.map((one) => one.page);
  return buildManifest({
    build: { id: "full", createdAt: "2026-08-29T10:00:00.000Z" },
    store: { seq: 100 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages, trailingSlash: "never" }),
    pages,
    entries: planEntries(DEMANDS, { modules: MODULES }),
    tiers,
    classes: [],
    foldTuning: new Map(),
    outputs: [...build.files, ...pages.map(html)],
  });
}

// Read from emitted text: an import specifier is the ESM edge, written verbatim
// through minification.
function reaches(build: ClientBuild, from: string): Set<string> {
  const names = new Map(
    build.files
      .filter((file) => file.kind === "js")
      .map((file) => [file.path.slice(file.path.lastIndexOf("/") + 1), file.path]),
  );
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    const file = build.files.find((one) => one.path === path);
    const text =
      typeof file?.contents === "string"
        ? file.contents
        : new TextDecoder().decode(file?.contents ?? new Uint8Array());
    for (const [name, target] of names) {
      if (target === path || seen.has(target)) continue;
      if (!text.includes(name)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

test("an incremental island edit re-emits one entry against the pinned core chunk's store", async () => {
  const first = await built();
  const tiers = planned(DEMANDS);
  const previous = manifestOf(first, tiers);

  const plan = planIncremental({
    previous,
    pages: DEMANDS.map((one) => one.page),
    delta: {
      since: 100,
      head: 101,
      changed: [{ collection: "pages", locale: "en", path: "en/blog" }],
      vanished: [],
      requested: [],
    },
  });
  expect(plan.render.map((one) => one.page.path)).toEqual(["/blog"]);
  expect(plan.pinned.tiers).toEqual(tiers);

  const rendered = [demand("/blog", "/en/blog", ["Hero", "Nav", "Chart"])];
  const second = await built(
    mergeDemands(plan.demands, rendered),
    plan.pinned.tiers,
  );

  const entryName = (demands: readonly PageDemand[]): string =>
    planEntries(demands, { modules: MODULES }).entries.find(
      (entry) => entry.path === "/blog",
    )?.name ?? "";
  const was = first.entryScripts.get(entryName(DEMANDS));
  const blogEntry = entryName(mergeDemands(plan.demands, rendered));
  expect(was).toBeDefined();
  expect(second.entryScripts.get(blogEntry)).toBeDefined();
  expect(second.entryScripts.get(blogEntry)).not.toBe(was);

  const core = second.files.find((file) => file.name === "fw-core");
  expect(core?.path).toBe(first.files.find((f) => f.name === "fw-core")?.path);

  const store = storeId(second);
  expect(chunksHolding(second, store)).toEqual([core?.path]);

  const entry = second.entryScripts.get(blogEntry) as string;
  expect([...reaches(second, entry)]).toContain(core?.path);
  const chart = chunksHolding(second, `${SRC}Chart.js`);
  expect(chart).toHaveLength(1);
  expect(chart[0]).not.toBe(core?.path);
}, 120_000);
