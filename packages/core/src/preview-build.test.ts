import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { afterAll, beforeAll, expect, expectTypeOf, test, vi } from "vitest";
import { buildClient } from "./client-build.js";
import { renderPage } from "./render.js";
import { buildPageTree } from "./tree.js";
import type { EntryNode, PageTreeInput } from "./tree.js";
import { ConfigError } from "./exit.js";
import { planEntries } from "./entries.js";
import type { PageDemand } from "./entries.js";
import { planPreview } from "./preview-entry.js";
import { previewBuild } from "./preview-build.test-support.js";
import { planTiers } from "./tiers.js";
import type { ComponentRegistry } from "@pagedeck/islands";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-preview-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const FIXTURE: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-4b71"; }\n`,
  "Tabs.js": `export default function Tabs() { return "marker-tabs-77c2"; }\n`,
  "Body.js": `export default function Body() { return "marker-body-9ce3"; }\n`,
  "Stamp.js": `import { randomUUID } from "node:crypto";\nexport default function Stamp() { return randomUUID(); }\n`,
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

const load = (): Promise<unknown> => Promise.resolve({});

const REGISTRY: ComponentRegistry = {
  Hero: { import: load },
  Tabs: { import: load, hydrate: "load" },
  Body: { import: load },
};

const MODULES = {
  Hero: "./src/Hero.js",
  Tabs: "./src/Tabs.js",
  Body: "./src/Body.js",
};

const ENTRY = planPreview(REGISTRY, {
  modules: MODULES,
  facts: { Tabs: { useClient: true } },
});

const EXTERNAL = ["react", "react-dom", "react-dom/client", "@pagedeck/preview"];

test("the preview target builds from one entry over the whole registry", async () => {
  const chunks = await previewBuild({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    entry: ENTRY,
    external: EXTERNAL,
  });

  expect(chunks.some((chunk) => chunk.name === "preview")).toBe(true);
  const code = chunks.map((chunk) => chunk.code).join("\n");
  for (const marker of ["marker-hero-4b71", "marker-tabs-77c2", "marker-body-9ce3"]) {
    expect(code).toContain(marker);
  }
  const app = chunks.find((chunk) => chunk.name === "preview");
  expect(app?.code).not.toContain("marker-hero-4b71");
  // Proves the id needle the production assertion uses really occurs in a graph holding
  // preview, so that assertion can fail.
  expect(app?.moduleIds).toContain(ENTRY.id);
});

test("a registered component reaching a node builtin is refused", async () => {
  const registry: ComponentRegistry = { ...REGISTRY, Stamp: { import: load } };
  const entry = planPreview(registry, {
    modules: { ...MODULES, Stamp: "./src/Stamp.js" },
  });

  const refusal = previewBuild({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    entry,
    external: EXTERNAL,
  });

  await expect(refusal).rejects.toBeInstanceOf(ConfigError);
  await expect(refusal).rejects.toThrow(/node:crypto/);
  await expect(refusal).rejects.toThrow(/Stamp\.js/);
  await expect(refusal).rejects.not.toThrow(/Hero\.js/);
});

test("two preview builds of one registry are byte-identical", async () => {
  const first = await previewBuild({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    entry: ENTRY,
    external: EXTERNAL,
  });
  const second = await previewBuild({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    entry: ENTRY,
    external: EXTERNAL,
  });
  expect(second.map((chunk) => [chunk.fileName, chunk.code])).toStrictEqual(
    first.map((chunk) => [chunk.fileName, chunk.code]),
  );
});

const PRODUCTION_PACKAGES = ["content", "islands", "core", "edge"];

const PREVIEW_PACKAGES = ["@pagedeck/preview"];

const PACKAGES_DIR = fileURLToPath(new URL("../../", import.meta.url));

type Manifest = { name: string; private?: boolean; dependencies?: Record<string, string> };

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(`${PACKAGES_DIR}${directory}/package.json`, "utf8")) as Manifest;
}

test("no package a production build is made of depends on the preview app", () => {
  for (const name of PRODUCTION_PACKAGES) {
    const manifest = readManifest(name);
    for (const forbidden of PREVIEW_PACKAGES) {
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(forbidden);
    }
  }
});

test("no package a production build is made of depends on a private workspace package", () => {
  const privatePackages = readdirSync(PACKAGES_DIR)
    .filter((directory) => existsSync(`${PACKAGES_DIR}${directory}/package.json`))
    .map(readManifest)
    .filter((manifest) => manifest.private === true)
    .map((manifest) => manifest.name);
  expect(privatePackages).not.toStrictEqual([]);
  for (const name of PRODUCTION_PACKAGES) {
    const dependencies = Object.keys(readManifest(name).dependencies ?? {});
    expect(dependencies.filter((dependency) => privatePackages.includes(dependency))).toStrictEqual(
      [],
    );
  }
});

type Declares<T, K extends string> = K extends keyof T ? true : false;

test("core's page render carries no hook and no field an adapter put there", async () => {
  const Hero = ({ headline }: { headline?: string }): ReturnType<typeof createElement> =>
    createElement("h1", null, headline);
  const registry: ComponentRegistry = {
    Hero: { import: () => Promise.resolve({ default: Hero }) },
  };
  const page = { locale: "en", path: "/home" } as const;
  const node = { component: "Hero", props: { headline: "One" }, sourceId: "uid-hero" };
  const decorate = vi.fn();

  const tree = await buildPageTree({
    page,
    content: { tree: [node] },
    registry,
    ...({ wrapNode: decorate } as object),
  } as PageTreeInput);

  expect(tree).toBeDefined();
  expect(decorate).not.toHaveBeenCalled();
  expectTypeOf<Declares<PageTreeInput, "wrapNode">>().toEqualTypeOf<false>();
  expectTypeOf<Declares<EntryNode, "sourceId">>().toEqualTypeOf<false>();

  const built = await renderPage({ page, tree: [node], registry });
  expect(built.html).toBe("<h1>One</h1>");
});

test("a production client build emits no preview bytes", async () => {
  const demands: readonly PageDemand[] = [
    {
      page: { locale: "en", path: "/", output: "/en", dependencies: [] },
      islands: [{ component: "Tabs", mode: "load" }],
    },
    {
      page: { locale: "en", path: "/about", output: "/en/about", dependencies: [] },
      islands: [{ component: "Hero", mode: "visible" }],
    },
  ];
  const plan = planEntries(demands, { modules: MODULES });
  const built = await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({ entries: plan.entries, ranking: [] }),
  });

  expect(built.files.length).toBeGreaterThan(0);
  for (const file of built.files) {
    expect(file.contents).not.toContain("fw-preview-build-target");
    expect(file.contents).not.toContain("mountPreview");
    expect(file.name).not.toBe("preview");
    for (const id of built.modules.get(file.path) ?? []) {
      expect(id).not.toContain("packages/preview/");
      expect(id).not.toBe(ENTRY.id);
    }
  }
}, 60_000);
