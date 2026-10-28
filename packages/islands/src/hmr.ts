import { createElement, useEffect, useState } from "react";
import type { ComponentType } from "react";

type AnyComponent = ComponentType<Record<string, unknown>>;

export type IslandModules = Readonly<
  Record<string, () => Promise<Readonly<Record<string, unknown>>>>
>;

// Typed here rather than through Vite's client types, which a Node build of
// this package has no business resolving.
export interface HotContext {
  readonly data: Record<string, unknown>;
}

export interface HotIslands {
  readonly hydrated: boolean;
  resolve(name: string, exported: string | null): Promise<ComponentType<never>>;
}

interface Swap {
  current: AnyComponent;
  readonly roots: Set<(component: AnyComponent) => void>;
}

interface HotName {
  readonly name: string;
  readonly key: string;
  readonly swap: Swap;
  readonly component: ComponentType<never>;
}

// On `hot.data`, not at module level: Vite re-executes this module too.
const SWAPS = "pagedeck:islands";

// The re-imports are not awaited, so one module's fetch never holds up the
// other islands' swaps.
export function hotIslands(
  hot: HotContext,
  modules: IslandModules,
): HotIslands {
  const existing = hot.data[SWAPS] as Map<string, HotName> | undefined;
  if (existing === undefined) {
    const mounted = new Map<string, HotName>();
    hot.data[SWAPS] = mounted;
    return {
      hydrated: false,
      resolve: (name, exported) => resolve(mounted, modules, name, exported),
    };
  }
  for (const known of existing.values()) void swap(modules, known);
  return {
    hydrated: true,
    resolve: (name, exported) => resolve(existing, modules, name, exported),
  };
}

async function resolve(
  mounted: Map<string, HotName>,
  modules: IslandModules,
  name: string,
  exported: string | null,
): Promise<ComponentType<never>> {
  const key = exported ?? "default";
  const module = await modules[name]();
  const current = module[key] as AnyComponent;
  const id = JSON.stringify([name, key]);
  const known = mounted.get(id);
  if (known !== undefined) {
    known.swap.current = current;
    return known.component;
  }
  const swap: Swap = { current, roots: new Set() };
  const fresh = {
    name,
    key,
    swap,
    component: hotComponent(swap) as ComponentType<never>,
  };
  mounted.set(id, fresh);
  return fresh.component;
}

// An unchanged module comes back as the same function, and re-mounting on it
// would reset every island on each edit.
async function swap(modules: IslandModules, known: HotName): Promise<void> {
  const swap_ = known.swap;
  const module = await modules[known.name]();
  const next = module[known.key] as AnyComponent;
  if (next === swap_.current) return;
  swap_.current = next;
  for (const root of swap_.roots) root(next);
}

// The effect re-subscribes on every `current` so it catches a swap that landed
// between this render and the effect.
function hotComponent(swap_: Swap): AnyComponent {
  return function HotIsland(props: Record<string, unknown>) {
    const [current, setCurrent] = useState<AnyComponent>(() => swap_.current);
    useEffect(() => {
      const root = (next: AnyComponent): void => {
        setCurrent(() => next);
      };
      swap_.roots.add(root);
      if (swap_.current !== current) root(swap_.current);
      return () => {
        swap_.roots.delete(root);
      };
    }, [current]);
    return createElement(current, props);
  };
}
