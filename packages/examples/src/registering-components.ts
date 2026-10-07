// Example: register components, merge a design system's registry with the site's, and resolve
// each component's hydration. Each component is declared once, by the path or package specifier
// of its module, which the build resolves against the config file; nothing here loads one.
import {
  defineComponents,
  mergeComponents,
  RegistryError,
  resolveComponent,
  resolveHydrationMode,
} from "@pagedeck/islands";
import type {
  ComponentDeclaration,
  ComponentDeclarations,
  ComponentPath,
  ResolvedHydration,
} from "@pagedeck/islands";

export interface RegisteredComponents {
  registry: ComponentDeclarations;
  hero: ComponentDeclaration;
  modes: Record<string, ResolvedHydration>;
  unregistered: string;
  warnings: string[];
}

const PAGE = { locale: "en", path: "/home" } as const;

export function registerComponents(): RegisteredComponents {
  // A design system's registry names its modules by package specifier, since it cannot know
  // where a site's config file sits. `carousel` overrides its directive's default: hydrate when
  // idle, not when visible.
  const carousel: ComponentPath = {
    path: "@acme/design-system/components/carousel",
    hydrate: "idle",
  };
  const designSystem = defineComponents({
    hero: "@acme/design-system/components/hero",
    carousel,
  });

  // The site's own components are paths relative to its config file. Its `hero` wins the merge,
  // and the shadowed one is warned about.
  const local = defineComponents({
    hero: "./components/site_hero.tsx",
    lead_form: "./components/lead_form.tsx",
    // A third-party widget cannot carry `"use client"`; an explicit `hydrate` islands it anyway.
    map_widget: { path: "@acme/maps/widget", hydrate: "load" },
  });

  // Without a sink, the warning goes to the run's error stream.
  const warnings: string[] = [];
  const registry = mergeComponents(designSystem, local, {
    warn: (message) => warnings.push(message),
  });

  // What the build's directive scan found; the registry takes it as an input.
  const directives: Record<string, boolean> = {
    hero: false,
    carousel: true,
    lead_form: true,
    map_widget: false,
  };

  const modes: Record<string, ResolvedHydration> = {};
  for (const [name, useClient] of Object.entries(directives)) {
    modes[name] = resolveHydrationMode(registry, name, PAGE, { useClient });
  }

  // An unregistered name fails, naming the component and the page.
  let unregistered = "no error";
  try {
    resolveComponent(registry, "testimonials", PAGE);
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    unregistered = error.message;
  }

  return {
    registry,
    hero: resolveComponent(registry, "hero", PAGE),
    modes,
    unregistered,
    warnings,
  };
}
