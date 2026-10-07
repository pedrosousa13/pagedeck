import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-dedupe-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const HOISTED = `${FIXTURE_DIR}node_modules/dup-store/`;
const NESTED = `${SRC}node_modules/dup-store/`;

const PACKAGE_JSON = JSON.stringify({
  name: "dup-store",
  version: "1.0.0",
  type: "module",
  main: "index.js",
});

const SKEW_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-skew-test/", import.meta.url),
);
const SKEW_SRC = `${SKEW_DIR}src/`;
const SKEW_ORIGIN = `${SKEW_DIR}pagedeck.config.js`;
const SKEW_HOISTED = `${SKEW_DIR}node_modules/skew-util/`;
const SKEW_NESTED = `${SKEW_SRC}node_modules/skew-util/`;

// Module-level state, not a constant: a literal-only module is inlined and leaves
// the graph.
const skewUtil = (marker: string): string => `let count = 0;
export const version = ${JSON.stringify(marker)};
export function bump() { count += 1; return count + version.length; }
export function read() { return count + version.length; }
`;

const skewPackageJson = (version: string): string =>
  JSON.stringify({
    name: "skew-util",
    version,
    type: "module",
    main: "index.js",
  });

// Identical in both copies: the defect is invisible to anything but the resolved id.
const STORE = `let count = 0;
export function bump() { count += 1; return count; }
export function read() { return count; }
`;

beforeAll(() => {
  mkdirSync(HOISTED, { recursive: true });
  mkdirSync(NESTED, { recursive: true });
  for (const copy of [HOISTED, NESTED]) {
    writeFileSync(`${copy}package.json`, PACKAGE_JSON);
    writeFileSync(`${copy}index.js`, STORE);
  }
  writeFileSync(
    `${SRC}Hero.js`,
    `import { bump } from "dup-store";
export default function Hero() { return "marker-hero-a41c" + String(bump()); }
`,
  );
  writeFileSync(
    `${SRC}Nav.js`,
    `export default function Nav() { return "marker-nav-6d02"; }\n`,
  );
  writeFileSync(
    `${FIXTURE_DIR}Chart.js`,
    `import { read } from "dup-store";
export default function Chart() { return "marker-chart-f7b8" + String(read()); }
`,
  );
  writeFileSync(ORIGIN, "export default {};\n");

  mkdirSync(SKEW_HOISTED, { recursive: true });
  mkdirSync(SKEW_NESTED, { recursive: true });
  writeFileSync(`${SKEW_HOISTED}package.json`, skewPackageJson("2.0.0"));
  writeFileSync(`${SKEW_HOISTED}index.js`, skewUtil("v2"));
  writeFileSync(`${SKEW_NESTED}package.json`, skewPackageJson("1.0.0"));
  writeFileSync(`${SKEW_NESTED}index.js`, skewUtil("v1"));
  writeFileSync(
    `${SKEW_SRC}Hero.js`,
    `import { bump } from "skew-util";
export default function Hero() { return "marker-hero-a41c" + String(bump()); }
`,
  );
  writeFileSync(
    `${SKEW_SRC}Nav.js`,
    `export default function Nav() { return "marker-nav-6d02"; }\n`,
  );
  writeFileSync(
    `${SKEW_DIR}Chart.js`,
    `import { read } from "skew-util";
export default function Chart() { return "marker-chart-f7b8" + String(read()); }
`,
  );
  writeFileSync(SKEW_ORIGIN, "export default {};\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  rmSync(SKEW_DIR, { recursive: true, force: true });
});

const MODULES = {
  Hero: "./src/Hero.js",
  Nav: "./src/Nav.js",
  Chart: "./Chart.js",
};

function demand(
  path: `/${string}`,
  output: string,
  components: readonly string[],
): PageDemand {
  const page: Page = { locale: "en", path, output, dependencies: [] };
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

async function build(root: string, origin: string): Promise<ClientBuild> {
  const plan = planEntries(DEMANDS, { modules: MODULES });
  return await buildClient({
    root,
    origin,
    plan,
    // `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
    // line each.
    tiers: planTiers({
      entries: plan.entries,
      ranking: [],
      policy: { minSize: 0 },
    }),
  });
}

test("two copies of one package fail the build, named by both paths", async () => {
  await expect(build(FIXTURE_DIR, ORIGIN)).rejects.toThrow(
    new ConfigError(
      [
        "Client build: 1 module came back from more than one copy of its package at one version, so islands sharing it would get an instance each — install one copy of the package, by deduplicating the lockfile or hoisting it into the site's own dependencies:",
        `  "dup-store/index.js" version 1.0.0 — at ${HOISTED}index.js, ${NESTED}index.js`,
      ].join("\n"),
    ),
  );
}, 60_000);

test("two versions of one package do not fail the build", async () => {
  const built = await build(SKEW_DIR, SKEW_ORIGIN);

  const ids = [...built.modules.values()].flat();
  expect(ids.filter((id) => id.endsWith("skew-util/index.js")).sort()).toEqual(
    [`${SKEW_HOISTED}index.js`, `${SKEW_NESTED}index.js`].sort(),
  );

  expect(
    new Set(
      [`${SKEW_HOISTED}index.js`, `${SKEW_NESTED}index.js`].map((id) =>
        id.slice(id.lastIndexOf("/node_modules/") + "/node_modules/".length),
      ),
    ),
  ).toEqual(new Set(["skew-util/index.js"]));
}, 60_000);
