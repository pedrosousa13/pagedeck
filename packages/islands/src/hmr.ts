import { createElement, useEffect, useState } from "react";
import type { ComponentType } from "react";

type AnyComponent = ComponentType<Record<string, unknown>>;

export type IslandModules = Readonly<
  Record<string, () => Promise<{ default: ComponentType<never> }>>
>;

// Typed here rather than through Vite's client types, which a Node build of
// this package has no business resolving.
export interface HotContext {
  readonly data: Record<string, unknown>;
}

export interface HotIslands {
  readonly hydrated: boolean;
  resolve(name: string): Promise<ComponentType<never>>;
}

interface Swap {
  current: AnyComponent;
  readonly roots: Set<(component: AnyComponent) => void>;
}

interface HotName {
  readonly swap: Swap;
  readonly component: ComponentType<never>;
}

// On `hot.data`, not at module level: Vite re-executes this module too.
const SWAPS = "fw:islands";

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
      resolve: (name) => resolve(mounted, modules, name),
    };
  }
  for (const [name, hot_] of existing) void swap(modules, name, hot_.swap);
  return {
    hydrated: true,
    resolve: (name) => resolve(existing, modules, name),
  };
}

async function resolve(
  mounted: Map<string, HotName>,
  modules: IslandModules,
  name: string,
): Promise<ComponentType<never>> {
  const module = await modules[name]();
  const known = mounted.get(name);
  if (known !== undefined) {
    known.swap.current = module.default as AnyComponent;
    return known.component;
  }
  const swap: Swap = {
    current: module.default as AnyComponent,
    roots: new Set(),
  };
  const fresh = {
    swap,
    component: hotComponent(swap) as ComponentType<never>,
  };
  mounted.set(name, fresh);
  return fresh.component;
}

// An unchanged module comes back as the same function, and re-mounting on it
// would reset every island on each edit.
async function swap(
  modules: IslandModules,
  name: string,
  swap_: Swap,
): Promise<void> {
  const module = await modules[name]();
  const next = module.default as AnyComponent;
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
