import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";
import type { TierPlan } from "./tiers.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-tiers-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

// Returned, not measured: oxc constant-folds a `.length` over a literal and drops it.
const FIXTURE: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-4b71"; }\n`,
  "Nav.js": `export default function Nav() { return "marker-nav-77c2"; }\n`,
  "Signup.js": `export default function Signup() { return "marker-signup-9ce3"; }\n`,
  "Chart.js": `export default function Chart() { return "marker-chart-2ad8"; }\n`,
  "Quote.js": `export default function Quote() { return "marker-quote-1f60"; }\n`,
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

function page(locale: string, path: `/${string}`, output: string): Page {
  return { locale, path, output, dependencies: [] };
}

const MODULES = {
  Hero: "./src/Hero.js",
  Nav: "./src/Nav.js",
  Signup: "./src/Signup.js",
  Chart: "./src/Chart.js",
  Quote: "./src/Quote.js",
};

interface Chunk {
  name: string;
  path: string;
  code: string;
}

function chunksOf(built: ClientBuild): Chunk[] {
  return built.files
    .filter((file) => file.kind === "js")
    .map((file) => ({
      name: file.name ?? "",
      path: file.path,
      code:
        typeof file.contents === "string"
          ? file.contents
          : new TextDecoder().decode(file.contents),
    }));
}

function demand(
  path: `/${string}`,
  output: string,
  components: readonly string[],
): PageDemand {
  return {
    page: page("en", path, output),
    islands: components.map((component) => ({
      component,
      mode: "visible" as const,
    })),
  };
}

const SHARED: readonly PageDemand[] = [
  demand("/", "/en", ["Hero", "Nav", "Signup"]),
  demand("/pricing", "/en/pricing", ["Hero", "Nav", "Signup"]),
  demand("/about", "/en/about", ["Hero", "Nav"]),
  demand("/blog", "/en/blog", ["Hero", "Nav"]),
];

const ONE = [...SHARED, demand("/blog/one", "/en/blog/one", ["Hero", "Chart"])];
const TWO = [...SHARED, demand("/careers", "/en/careers", ["Hero", "Quote"])];

const ALIASED: readonly PageDemand[] = [
  demand("/", "/en", ["Hero", "Banner"]),
  demand("/pricing", "/en/pricing", ["Hero", "Banner"]),
  demand("/about", "/en/about", ["Hero"]),
  demand("/blog", "/en/blog", ["Hero"]),
  demand("/careers", "/en/careers", ["Hero"]),
];

// `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
// line each.
async function tieredBuild(
  demands: readonly PageDemand[],
  modules: Record<string, string> = MODULES,
): Promise<{ built: ClientBuild; chunks: Chunk[]; tiers: TierPlan }> {
  const plan = planEntries(demands, { modules });
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
  return { built, chunks: chunksOf(built), tiers };
}

function chunkNamed(chunks: readonly Chunk[], name: string): Chunk | undefined {
  return chunks.find((chunk) => chunk.name === name);
}

test("a group captures a component reached only by a dynamic import", async () => {
  const { chunks } = await tieredBuild(ONE);
  const core = chunkNamed(chunks, "fw-core");

  expect(core).toBeDefined();
  expect(core?.code).toContain("marker-hero-4b71");
  expect(core?.code).toContain("marker-nav-77c2");
  expect(core?.code.length).toBeGreaterThan(0);
}, 60_000);

test("the mid tier takes the component that clears pages but not share", async () => {
  const { chunks } = await tieredBuild(ONE);

  const mid = chunks.filter((chunk) => chunk.name.startsWith("fw-mid"));
  expect(mid.map((chunk) => chunk.code).join("\n")).toContain(
    "marker-signup-9ce3",
  );
  expect(chunkNamed(chunks, "fw-core")?.code).not.toContain(
    "marker-signup-9ce3",
  );
}, 60_000);

test("the islands runtime ships in the core chunk", async () => {
  const { built, chunks } = await tieredBuild(ONE);

  const core = chunkNamed(chunks, "fw-core");
  expect(built.modules.get(core?.path ?? "")).toContain(
    built.ids["@pagedeck/islands/runtime"],
  );
}, 60_000);

test("a component on one page keeps its bytes out of core", async () => {
  const { chunks } = await tieredBuild(ONE);
  const core = chunkNamed(chunks, "fw-core");

  expect(core?.code).not.toContain("marker-chart-2ad8");
  const holders = chunks.filter((chunk) =>
    chunk.code.includes("marker-chart-2ad8"),
  );
  expect(holders).toHaveLength(1);
  expect(holders[0]?.name).not.toBe("fw-core");
  expect(holders[0]?.name).not.toBe("fw-mid");
}, 60_000);

test("an aliased specifier ships in the group the plan recorded", async () => {
  const { chunks, tiers } = await tieredBuild(ALIASED, {
    ...MODULES,
    Banner: "./src/Hero.js",
  });

  const banner = tiers.assignments.find((one) => one.component === "Banner");
  expect(banner?.group).toBe("fw-core");
  expect(chunkNamed(chunks, "fw-core")?.code).toContain("marker-hero-4b71");
  expect(chunks.filter((chunk) => chunk.name.startsWith("fw-mid"))).toEqual([]);
}, 60_000);

test("the core chunk survives two builds whose pages differ", async () => {
  const { chunks: one } = await tieredBuild(ONE);
  const { chunks: two } = await tieredBuild(TWO);

  expect(one.map((chunk) => chunk.name)).not.toEqual(
    two.map((chunk) => chunk.name),
  );
  const first = chunkNamed(one, "fw-core");
  const second = chunkNamed(two, "fw-core");
  expect(second?.path).toBe(first?.path);
  expect(second?.code).toBe(first?.code);
}, 60_000);
