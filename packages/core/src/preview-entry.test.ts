import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import { planPreview, renderPreviewModule } from "./preview-entry.js";
import type { ComponentRegistry } from "@pagedeck/islands";

const load = (): Promise<unknown> => Promise.resolve({});

const REGISTRY: ComponentRegistry = {
  Tabs: { import: load, hydrate: "load" },
  Hero: { import: load },
  Body: { import: load, hydrate: "none" },
};

const MODULES = {
  Hero: "./components/Hero.js",
  Tabs: "./components/Tabs.js",
  Body: "./components/Body.js",
};

test("the whole registry is one entry, sorted by name", () => {
  const entry = planPreview(REGISTRY, { modules: MODULES });
  expect(entry.id).toBe("\0fw:preview/app");
  expect(entry.name).toBe("preview");
  expect(entry.components).toStrictEqual([
    { name: "Body", module: "./components/Body.js", hydrate: "none" },
    { name: "Hero", module: "./components/Hero.js" },
    { name: "Tabs", module: "./components/Tabs.js", hydrate: "load" },
  ]);
});

test("its id is disjoint from a page entry's", () => {
  expect(planPreview(REGISTRY, { modules: MODULES }).id).not.toContain(
    "\0fw:entry/",
  );
});

test("directive facts are carried with their keys sorted", () => {
  const entry = planPreview(REGISTRY, {
    modules: MODULES,
    facts: { Tabs: { useClient: true }, Hero: { useClient: false } },
  });
  expect(Object.keys(entry.modules)).toStrictEqual(["Hero", "Tabs"]);
});

test("every unmapped registered component is reported in one failure", () => {
  const thrown = (() => {
    try {
      planPreview(REGISTRY, { modules: { Hero: "./components/Hero.js" } });
    } catch (error) {
      return error;
    }
    return undefined;
  })();

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    [
      "Preview entry: 2 components have no module to import — the preview target loads the whole registry, so a component no page renders still needs a specifier: pass each one's specifier in planPreview's modules option, or drop each from the registry passed to planPreview:",
      '  "Body"',
      '  "Tabs"',
    ].join("\n"),
  );
});

test("one unmapped component keeps the singular sentence", () => {
  expect(() =>
    planPreview(REGISTRY, {
      modules: { Hero: "./components/Hero.js", Tabs: "./components/Tabs.js" },
    }),
  ).toThrow(
    'Preview entry: 1 component has no module to import — the preview target loads the whole registry, so a component no page renders still needs a specifier: pass its specifier in planPreview\'s modules option, or drop it from the registry passed to planPreview:\n  "Body"',
  );
});

test("a registry name that is a prototype key is read off the registry, not the prototype", () => {
  const registry = { constructor: { import: load } } as ComponentRegistry;
  expect(() => planPreview(registry, { modules: {} })).toThrow(
    'Preview entry: 1 component has no module to import',
  );
  expect(
    planPreview(registry, { modules: { constructor: "./x.js" } }).components,
  ).toStrictEqual([{ name: "constructor", module: "./x.js" }]);
});

test("the emitted module is the whole registry behind dynamic imports", () => {
  const entry = planPreview(REGISTRY, {
    modules: MODULES,
    facts: { Tabs: { useClient: true } },
    providers: "./providers.js",
    bridge: "./cms-bridge.js",
  });
  expect(renderPreviewModule(entry)).toBe(
    [
      'import { mountPreview } from "@pagedeck/preview";',
      'import bridge from "./cms-bridge.js";',
      'import providers from "./providers.js";',
      'import { checkSharedStore } from "@pagedeck/islands/store-stamp";',
      "const registry = {",
      '  "Body": { import: () => import("./components/Body.js"), hydrate: "none" },',
      '  "Hero": { import: () => import("./components/Hero.js") },',
      '  "Tabs": { import: () => import("./components/Tabs.js"), hydrate: "load" },',
      "};",
      "checkSharedStore(providers, false);",
      "mountPreview({",
      "  registry,",
      '  modules: {"Tabs":{"useClient":true}},',
      "  providers,",
      "  bridge,",
      "});",
      "",
    ].join("\n"),
  );
});

test("a site with no providers and no bridge emits neither import", () => {
  const text = renderPreviewModule(planPreview(REGISTRY, { modules: MODULES }));
  expect(text).not.toContain("providers");
  expect(text).not.toContain("bridge");
});

test("a name holding a quote emits a module that still parses", () => {
  const entry = planPreview({ 'He"ro': { import: load } } as ComponentRegistry, {
    modules: { 'He"ro': './a"b.js' },
  });
  expect(renderPreviewModule(entry)).toContain(
    '  "He\\"ro": { import: () => import("./a\\"b.js") },',
  );
});
