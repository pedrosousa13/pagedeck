import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { EntryPlan, IslandInstance } from "./entries.js";
import type { Page } from "./pages.js";
import { CORE_GROUP, planTiers } from "./tiers.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-lazy-runtime-test/", import.meta.url),
);
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const MODULES = {
  Hero: "./src/Hero.js",
  Nav: "./src/Nav.js",
};

beforeAll(() => {
  mkdirSync(`${FIXTURE_DIR}src`, { recursive: true });
  writeFileSync(
    `${FIXTURE_DIR}src/Hero.js`,
    `export default function Hero() { return "marker-hero-31c9"; }\n`,
  );
  writeFileSync(
    `${FIXTURE_DIR}src/Nav.js`,
    `export default function Nav() { return "marker-nav-8d02"; }\n`,
  );
  writeFileSync(`${FIXTURE_DIR}src/global.css`, ".fw-global { color: red; }\n");
  writeFileSync(ORIGIN, "export default {};\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function page(path: `/${string}`): Page {
  return { locale: "en", path, output: `/en${path}`, dependencies: [] };
}

function staticClosure(built: ClientBuild, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    queue.push(...(built.imports.get(path) ?? []));
  }
  return seen;
}

let plan: EntryPlan;
let built: ClientBuild;

// `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
// line each.
beforeAll(async () => {
  const islands = (
    ...pairs: [string, IslandInstance["mode"]][]
  ): IslandInstance[] =>
    pairs.map(([component, mode]) => ({ component, mode }));
  plan = planEntries(
    [
      { page: page("/"), islands: islands(["Hero", "load"], ["Nav", "visible"]) },
      { page: page("/later"), islands: islands(["Hero", "idle"], ["Nav", "visible"]) },
    ],
    { modules: MODULES },
  );
  built = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [], policy: { minSize: 0 } }),
  });
}, 60_000);

function closureOf(path: `/${string}`): Set<string> {
  const entry = plan.entries.find((one) => one.path === path);
  const script = built.entryScripts.get(entry?.name ?? "");
  expect(script).toBeDefined();
  return staticClosure(built, script as string);
}

function corePath(): string {
  const core = built.files.find(
    (file) => file.kind === "js" && file.name === CORE_GROUP,
  );
  expect(core).toBeDefined();
  return core?.path as string;
}

test("a page whose islands are all idle or visible does not import the core chunk at startup", () => {
  expect(closureOf("/later")).not.toContain(corePath());
});

test("a page with a load island still imports the core chunk at startup", () => {
  expect(closureOf("/")).toContain(corePath());
});

test("a global stylesheet still reaches a site where no page imports the core chunk at startup", async () => {
  const later = planEntries(
    [{ page: page("/later"), islands: [{ component: "Hero", mode: "idle" }] }],
    { modules: MODULES },
  );
  const site = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: later,
    tiers: planTiers({ entries: later.entries, ranking: [], policy: { minSize: 0 } }),
    globalCss: [`${FIXTURE_DIR}src/global.css`],
  });

  expect(site.globalStyles).toHaveLength(1);
  expect(site.entryStyles.get(later.entries[0]?.name ?? "")).toEqual(
    site.globalStyles,
  );
}, 60_000);

test("a page with no load island links the stylesheet of an island grouped into the core chunk", async () => {
  writeFileSync(`${FIXTURE_DIR}src/styled.css`, ".styled { color: blue; }\n");
  writeFileSync(
    `${FIXTURE_DIR}src/Styled.js`,
    `import "./styled.css";\nexport default function Styled() { return "marker-styled-5e1a"; }\n`,
  );
  const later = planEntries(
    [{ page: page("/later"), islands: [{ component: "Styled", mode: "idle" }] }],
    { modules: { Styled: "./src/Styled.js" } },
  );
  const site = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan: later,
    tiers: planTiers({
      entries: later.entries,
      ranking: [],
      policy: { minSize: 0 },
      alwaysCore: ["./src/Styled.js"],
    }),
  });
  const core = site.files.find((file) => file.kind === "js" && file.name === CORE_GROUP);
  expect(String(core?.contents)).toContain("marker-styled-5e1a");
  const sheet = site.files.find((file) => file.kind === "css");

  expect(site.entryStyles.get(later.entries[0]?.name ?? "")).toEqual([sheet?.path]);
}, 60_000);
