import { expect, expectTypeOf, test, vi } from "vitest";
import {
  componentFaults,
  defineComponents,
  getComponent,
  installRegistryWarnings,
  mergeComponents,
  RegistryError,
  resolveComponent,
  resolveHydrationMode,
} from "./registry.js";
import type {
  ComponentDeclaration,
  ComponentDeclarations,
  ComponentRegistry,
} from "./registry.js";

const FIX =
  'name its module by a path relative to the config file, such as "./components/<module>.tsx", or by a package specifier, such as "<package>/<module>"';

function thunkOf(name: string): () => Promise<unknown> {
  return vi.fn(async () => ({ default: name }));
}

test("defineComponents takes no loader, in its types or at run time", () => {
  const thunk = thunkOf("Hero");

  const failing = () =>
    defineComponents({
      // @ts-expect-error A loader is not a component declaration.
      hero: { import: thunk },
    });

  expect(failing).toThrowError(RegistryError);
  expect(failing).toThrowError(
    `Component registry: 1 component is not usable — fix each one:
  "hero": declares a loader, import, which was removed — ${FIX}`,
  );
  expect(thunk).not.toHaveBeenCalled();
});

test("resolving an unregistered component names it and the page", () => {
  const registry = defineComponents({ hero: "./components/hero.tsx" });

  const failing = () =>
    resolveComponent(registry, "lead_form", { locale: "en", path: "/home" });

  expect(failing).toThrowError(RegistryError);
  expect(failing).toThrowError(
    'Component "lead_form": not registered, and entry /en/home references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
  );
});

test("getComponent reports an unregistered component without throwing", () => {
  const registry = defineComponents({
    hero: { path: "./components/hero.tsx", hydrate: "idle" },
  });

  expect(getComponent(registry, "lead_form")).toBeUndefined();
  expect(getComponent(registry, "hero")).toBe(registry.hero);
});

test("merging keeps both sides' components", () => {
  const designSystem = defineComponents({ hero: "@acme/ds/hero" });
  const local = defineComponents({ lead_form: "./components/lead_form.tsx" });

  const merged = mergeComponents(designSystem, local);

  expect(merged.hero).toBe(designSystem.hero);
  expect(merged.lead_form).toBe(local.lead_form);
});

test("merging lets the local registry win a collision, with a warning", () => {
  const warn = vi.fn();
  const designSystem = defineComponents({ hero: "@acme/ds/hero" });
  const local = defineComponents({ hero: "./components/hero.tsx" });

  const merged = mergeComponents(designSystem, local, { warn });

  expect(merged.hero).toBe(local.hero);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'Component "hero": registered by two merged registries — the later one wins and the earlier one is unreachable; rename one of them, or drop the merge',
  );
});

test("a caller that passes no warn sink, under no run, gets console.warn", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  mergeComponents(
    defineComponents({ hero: "@acme/ds/hero" }),
    defineComponents({ hero: "./components/hero.tsx" }),
  );

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'Component "hero": registered by two merged registries — the later one wins and the earlier one is unreachable; rename one of them, or drop the merge',
  );
  warn.mockRestore();
});

test("an installed sink takes the collision a caller did not route itself", () => {
  const console_ = vi.spyOn(console, "warn").mockImplementation(() => {});
  const collected: string[] = [];
  const restore = installRegistryWarnings((message) => {
    collected.push(message);
  });

  mergeComponents(
    defineComponents({ hero: "@acme/ds/hero" }),
    defineComponents({ hero: "./components/hero.tsx" }),
  );
  restore();

  expect(collected).toEqual([
    'Component "hero": registered by two merged registries — the later one wins and the earlier one is unreachable; rename one of them, or drop the merge',
  ]);
  expect(console_).not.toHaveBeenCalled();
  console_.mockRestore();
});

test("restoring the channel puts the console back", () => {
  const console_ = vi.spyOn(console, "warn").mockImplementation(() => {});
  const collected: string[] = [];
  installRegistryWarnings((message) => {
    collected.push(message);
  })();

  mergeComponents(
    defineComponents({ hero: "@acme/ds/hero" }),
    defineComponents({ hero: "./components/hero.tsx" }),
  );

  expect(collected).toEqual([]);
  expect(console_).toHaveBeenCalledOnce();
  console_.mockRestore();
});

test("a nested run's restore gives the channel back to the outer run", () => {
  const console_ = vi.spyOn(console, "warn").mockImplementation(() => {});
  const outer: string[] = [];
  const inner: string[] = [];
  const restoreOuter = installRegistryWarnings((message) => {
    outer.push(message);
  });
  installRegistryWarnings((message) => {
    inner.push(message);
  })();

  mergeComponents(
    defineComponents({ hero: "@acme/ds/hero" }),
    defineComponents({ hero: "./components/hero.tsx" }),
  );
  restoreOuter();

  expect(inner).toEqual([]);
  expect(outer).toHaveLength(1);
  expect(console_).not.toHaveBeenCalled();
  console_.mockRestore();
});

test("a caller's own warn sink wins over an installed one", () => {
  const warn = vi.fn();
  const collected: string[] = [];
  const restore = installRegistryWarnings((message) => {
    collected.push(message);
  });

  mergeComponents(
    defineComponents({ hero: "@acme/ds/hero" }),
    defineComponents({ hero: "./components/hero.tsx" }),
    { warn },
  );
  restore();

  expect(warn).toHaveBeenCalledOnce();
  expect(collected).toEqual([]);
});

test("merging does not mutate either input registry", () => {
  const designSystem = defineComponents({ hero: "@acme/ds/hero" });
  const local = defineComponents({ lead_form: "./components/lead_form.tsx" });

  mergeComponents(designSystem, local);

  expect(Object.keys(designSystem)).toEqual(["hero"]);
  expect(Object.keys(local)).toEqual(["lead_form"]);
});

const HOME = { locale: "en", path: "/home" } as const;

test("a directive-carrying component with no explicit hydrate defaults to visible", () => {
  const registry = defineComponents({
    lead_form: "./components/lead_form.tsx",
  });

  expect(
    resolveHydrationMode(registry, "lead_form", HOME, { useClient: true }),
  ).toEqual({ mode: "visible", source: "defaulted" });
});

test("a component with no directive and no explicit hydrate defaults to none", () => {
  const registry = defineComponents({
    hero: { path: "./components/hero.tsx" },
  });

  expect(
    resolveHydrationMode(registry, "hero", HOME, { useClient: false }),
  ).toEqual({ mode: "none", source: "defaulted" });
});

test("an explicit hydrate overrides the directive-derived default", () => {
  const registry = defineComponents({
    carousel: { path: "./components/carousel.tsx", hydrate: "idle" },
  });

  expect(
    resolveHydrationMode(registry, "carousel", HOME, { useClient: true }),
  ).toEqual({ mode: "idle", source: "declared" });
});

test("an explicit hydrate on a directive-less module forces islandhood", () => {
  const registry = defineComponents({
    third_party: { path: "./components/third_party.tsx", hydrate: "load" },
  });

  expect(
    resolveHydrationMode(registry, "third_party", HOME, { useClient: false }),
  ).toEqual({ mode: "load", source: "declared" });
});

test("an explicit hydrate: none on a directive-less module resolves to none", () => {
  const registry = defineComponents({
    hero: { path: "./components/hero.tsx", hydrate: "none" },
  });

  expect(
    resolveHydrationMode(registry, "hero", HOME, { useClient: false }),
  ).toEqual({ mode: "none", source: "declared" });
});

test("an explicitly declared visible is distinguishable from a defaulted one", () => {
  const registry = defineComponents({
    declared: { path: "./components/declared.tsx", hydrate: "visible" },
    defaulted: "./components/defaulted.tsx",
  });

  expect(
    resolveHydrationMode(registry, "declared", HOME, { useClient: true }),
  ).toEqual({ mode: "visible", source: "declared" });
  expect(
    resolveHydrationMode(registry, "defaulted", HOME, { useClient: true }),
  ).toEqual({ mode: "visible", source: "defaulted" });
});

test('"use client" plus an explicit hydrate: none fails', () => {
  const registry = defineComponents({
    lead_form: { path: "./components/lead_form.tsx", hydrate: "none" },
  });

  const failing = () =>
    resolveHydrationMode(registry, "lead_form", HOME, { useClient: true });

  expect(failing).toThrowError(RegistryError);
  expect(failing).toThrowError(
    'Component "lead_form": its module carries "use client" but the registry declares hydrate: "none", and entry /en/home renders it — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module',
  );
});

test("resolving a hydration mode refuses an unregistered component", () => {
  const registry = defineComponents({ hero: "./components/hero.tsx" });

  expect(() =>
    resolveHydrationMode(registry, "lead_form", HOME, { useClient: true }),
  ).toThrowError('Component "lead_form": not registered');
});

test("the registry a config loads resolves a hydration mode without calling its loader", () => {
  const thunk = thunkOf("LeadForm");
  const registry: ComponentRegistry = {
    lead_form: { import: thunk, hydrate: "idle" },
  };

  expect(
    resolveHydrationMode(registry, "lead_form", HOME, { useClient: true }),
  ).toEqual({ mode: "idle", source: "declared" });
  expect(resolveComponent(registry, "lead_form", HOME)).toBe(
    registry["lead_form"],
  );
  expect(thunk).not.toHaveBeenCalled();
});

// Cast on purpose: these checks exist for callers without the types.
function malformed(
  components: Record<string, unknown>,
): Record<string, ComponentDeclaration> {
  return components as Record<string, ComponentDeclaration>;
}

test("defineComponents reports every malformed entry in one throw", () => {
  const failing = () =>
    defineComponents(
      malformed({
        hero: {},
        lead_form: { import: "./LeadForm" },
        carousel: { path: "./components/carousel.tsx", hydrate: "sometimes" },
        banner: null,
        ok: { path: "./components/ok.tsx", hydrate: "load" },
      }),
    );

  expect(failing).toThrowError(RegistryError);
  expect(failing).toThrowError(
    `Component registry: 4 components are not usable — fix each one:
  "hero": declares no path — ${FIX}
  "lead_form": declares a loader, import, which was removed — ${FIX}
  "carousel": hydrate "sometimes" is not a hydration mode — use "none", "load", "visible" or "idle"
  "banner": is null, not a component definition — ${FIX}`,
  );
});

test("defineComponents names a single malformed entry in the singular", () => {
  expect(() => defineComponents(malformed({ hero: {} }))).toThrowError(
    `Component registry: 1 component is not usable — fix each one:
  "hero": declares no path — ${FIX}`,
  );
});

test("the merged registry type carries both sides' component names", () => {
  const merged = mergeComponents(
    defineComponents({ hero: "@acme/ds/hero" }),
    defineComponents({ lead_form: "./components/lead_form.tsx" }),
  );

  expectTypeOf(merged).toEqualTypeOf<
    ComponentDeclarations<"hero" | "lead_form">
  >();
});

test("defineComponents takes a component declared by path, bare or with options", () => {
  const registry = defineComponents({
    layout: "./components/layout.tsx",
    counter: { path: "./components/counter.tsx", hydrate: "load" },
  });

  expect(registry).toEqual({
    layout: "./components/layout.tsx",
    counter: { path: "./components/counter.tsx", hydrate: "load" },
  });
  expectTypeOf(registry).toEqualTypeOf<
    ComponentDeclarations<"layout" | "counter">
  >();
});

test("defineComponents reports every unusable path in one throw", () => {
  const failing = () =>
    defineComponents(
      malformed({
        empty: "",
        blank: "   ",
        empty_option: { path: "" },
        numbered: { path: 42 },
        both: { path: "./components/both.tsx", import: thunkOf("Both") },
        moded: { path: "./components/moded.tsx", hydrate: "eventually" },
        ok: { path: "./components/ok.tsx", hydrate: "visible" },
      }),
    );

  expect(failing).toThrowError(RegistryError);
  expect(failing).toThrowError(
    `Component registry: 6 components are not usable — fix each one:
  "empty": path is empty — ${FIX}
  "blank": path is only whitespace — ${FIX}
  "empty_option": path is empty — ${FIX}
  "numbered": path is a number, not a string — ${FIX}
  "both": declares both path and import, and import was removed — keep path and drop import
  "moded": hydrate "eventually" is not a hydration mode — use "none", "load", "visible" or "idle"`,
  );
});

test("merging takes registries declared by path, and a later declaration still wins", () => {
  const warn = vi.fn();
  const merged = mergeComponents(
    defineComponents({
      hero: "@acme/design-system/components/hero",
      carousel: {
        path: "@acme/design-system/components/carousel",
        hydrate: "idle",
      },
    }),
    defineComponents({
      hero: "./components/site_hero.tsx",
      lead_form: { path: "./components/lead_form.tsx", hydrate: "load" },
    }),
    { warn },
  );

  expect(merged).toEqual({
    hero: "./components/site_hero.tsx",
    carousel: { path: "@acme/design-system/components/carousel", hydrate: "idle" },
    lead_form: { path: "./components/lead_form.tsx", hydrate: "load" },
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expectTypeOf(merged).toEqualTypeOf<
    ComponentDeclarations<"hero" | "carousel" | "lead_form">
  >();
});

test("a registry declared by path resolves a component and its hydration without loading it", () => {
  const registry = defineComponents({
    hero: "./components/hero.tsx",
    carousel: { path: "./components/carousel.tsx", hydrate: "idle" },
  });

  expect(resolveComponent(registry, "hero", HOME)).toBe("./components/hero.tsx");
  expect(getComponent(registry, "carousel")).toEqual({
    path: "./components/carousel.tsx",
    hydrate: "idle",
  });
  expect(
    resolveHydrationMode(registry, "hero", HOME, { useClient: true }),
  ).toEqual({ mode: "visible", source: "defaulted" });
  expect(
    resolveHydrationMode(registry, "carousel", HOME, { useClient: true }),
  ).toEqual({ mode: "idle", source: "declared" });
});

test("componentFaults names each unusable definition without throwing", () => {
  expect(
    componentFaults({
      hero: "",
      ok: "./components/ok.tsx",
      banner: null,
      legacy: { import: thunkOf("Legacy") },
    }),
  ).toEqual([
    '"hero": path is empty — ' + FIX,
    '"banner": is null, not a component definition — ' + FIX,
    '"legacy": declares a loader, import, which was removed — ' + FIX,
  ]);
});
