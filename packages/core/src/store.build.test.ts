import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import type { Page } from "./pages.js";
import { planTiers } from "./tiers.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-store-build-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

// `atom` from `@pagedeck/islands/store`, not `jotai`: that is how a site writes it, and
// `@pagedeck/core` does not depend on `jotai`.
const FIXTURE: Record<string, string> = {
  "atoms.js": `import { atom } from "@pagedeck/islands/store";
export const countAtom = atom(0);
`,
  "Hero.js": `import { store } from "@pagedeck/islands/store";
import { countAtom } from "./atoms.js";
export default function Hero() {
  store.set(countAtom, 1);
  return "marker-hero-2ad9" + String(store.get(countAtom));
}
`,
  "Chart.js": `import { store } from "@pagedeck/islands/store";
import { countAtom } from "./atoms.js";
export default function Chart() {
  return "marker-chart-6f10" + String(store.get(countAtom));
}
`,
  "Nav.js": `export default function Nav() { return "marker-nav-8b52"; }\n`,
  "providers.js": `import { Provider, store } from "@pagedeck/islands/store";
export default [{ component: Provider, props: { store } }];
`,
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
  const page: Page = {
    locale: "en",
    path,
    output,
    collection: "pages",
    entry: { locale: "en", path: output.slice(1) },
    dependencies: [],
  };
  return {
    page,
    islands: components.map((component) => ({
      component,
      mode: "load" as const,
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

function chunksHolding(build: ClientBuild, id: string): string[] {
  return [...build.modules]
    .filter(([, ids]) => ids.includes(id))
    .map(([path]) => path);
}

function idsEnding(build: ClientBuild, suffix: string): string[] {
  return [
    ...new Set(
      [...build.modules.values()].flat().filter((id) => id.endsWith(suffix)),
    ),
  ];
}

const PROVIDERS = `${SRC}providers.js`;

test("the framework store module is in exactly one chunk, reached from two tiers", async () => {
  const plan = planEntries(DEMANDS, {
    modules: MODULES,
    providers: PROVIDERS,
    providersDigest: "stack[0] store=object",
  });
  const build = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    // `minSize: 0`: Rolldown ignores a group below `minSize`, and these components are a
    // line each.
    tiers: planTiers({ entries: plan.entries, ranking: [], policy: { minSize: 0 } }),
  });

  const core = build.files.find((file) => file.name === "fw-core");
  const corePath = core?.path ?? "";
  expect(build.modules.get(corePath) ?? []).toContain(`${SRC}Hero.js`);
  expect(build.modules.get(corePath) ?? []).not.toContain(`${SRC}Chart.js`);

  const store = idsEnding(build, "/islands/dist/store.js");
  expect(store).toHaveLength(1);
  expect(chunksHolding(build, store[0] as string)).toEqual([corePath]);

  const atoms = idsEnding(build, `${SRC}atoms.js`);
  expect(atoms).toEqual([`${SRC}atoms.js`]);
  expect(chunksHolding(build, `${SRC}atoms.js`)).toHaveLength(1);

  const jotai = idsEnding(build, "/jotai/esm/vanilla.mjs");
  expect(jotai).toHaveLength(1);
  expect(chunksHolding(build, jotai[0] as string)).toHaveLength(1);

  expect(idsEnding(build, "/islands/dist/store-stamp.js")).toHaveLength(1);

  // `import.meta.env`, not `import.meta`: Vite writes `import.meta.url` into its own
  // chunk preamble.
  for (const file of build.files) {
    if (file.kind !== "js") continue;
    const text =
      typeof file.contents === "string"
        ? file.contents
        : new TextDecoder().decode(file.contents);
    expect(text).not.toContain("import.meta.env");
  }
}, 60_000);
