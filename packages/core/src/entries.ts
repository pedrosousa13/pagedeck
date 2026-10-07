import { createHash } from "node:crypto";
import { ConfigError } from "./exit.js";
import type { Page } from "./pages.js";
import type { HydrationMode } from "@pagedeck/islands";

export type ModuleMap = Readonly<Record<string, string>>;

export interface IslandInstance {
  component: string;
  mode: Exclude<HydrationMode, "none">;
}

export interface CarriedComponent {
  name: string;
  eager: boolean;
}

export type PageDemand =
  | {
      page: Page;
      islands: readonly IslandInstance[];
    }
  | {
      page: Page;
      carried: readonly CarriedComponent[];
    };

export interface EntryComponent {
  name: string;
  module: string;
  eager: boolean;
}

export interface PageEntry {
  locale: string;
  path: string;
  id: string;
  name: string;
  components: readonly EntryComponent[];
  providers?: string;
  providersDigest?: string;
}

export type EntryText = Pick<
  PageEntry,
  "components" | "providers" | "providersDigest"
>;

export interface ContentOnlyPage {
  locale: string;
  path: string;
}

export interface EntryPlan {
  entries: readonly PageEntry[];
  contentOnly: readonly ContentOnlyPage[];
}

export interface PlanEntriesOptions {
  modules: ModuleMap;
  providers?: string;
  providersDigest?: string;
}

const VIRTUAL_PREFIX = "\0fw:entry/";

const MISSING_MODULE_FIX = {
  one: "pass its specifier in planEntries' modules option, or drop it from the pages that use it",
  many: "pass each one's specifier in planEntries' modules option, or drop it from the pages that use it",
} as const;

function beforePage(
  a: { locale: string; path: string },
  b: { locale: string; path: string },
): number {
  if (a.locale !== b.locale) return a.locale < b.locale ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function entryName(text: string): string {
  return `entry-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

interface MissingModule {
  name: string;
  usedBy: string[];
}

function missingModuleReport(missing: readonly MissingModule[]): string {
  const count = missing.length;
  const headline =
    count === 1
      ? `1 component has no module to import — ${MISSING_MODULE_FIX.one}`
      : `${String(count)} components have no module to import — ${MISSING_MODULE_FIX.many}`;
  const detail = missing
    .map((one) => `  "${one.name}" — used by ${one.usedBy.join(", ")}`)
    .join("\n");
  return `Entry modules: ${headline}:\n${detail}`;
}

export function planEntries(
  demands: readonly PageDemand[],
  options: PlanEntriesOptions,
): EntryPlan {
  const entries: PageEntry[] = [];
  const contentOnly: ContentOnlyPage[] = [];
  const missing = new Map<string, MissingModule>();

  for (const demand of demands) {
    const { page } = demand;
    const eagerByName = new Map<string, boolean>();
    if ("islands" in demand) {
      for (const island of demand.islands) {
        eagerByName.set(
          island.component,
          (eagerByName.get(island.component) ?? false) || island.mode === "load",
        );
      }
    } else {
      for (const component of demand.carried) {
        eagerByName.set(
          component.name,
          (eagerByName.get(component.name) ?? false) || component.eager,
        );
      }
    }

    if (eagerByName.size === 0) {
      contentOnly.push({ locale: page.locale, path: page.path });
      continue;
    }

    const components: EntryComponent[] = [];
    for (const [name, eager] of eagerByName) {
      const module = Object.hasOwn(options.modules, name)
        ? options.modules[name]
        : undefined;
      if (module === undefined) {
        const seen = missing.get(name);
        if (seen === undefined) {
          missing.set(name, { name, usedBy: [page.output] });
        } else {
          seen.usedBy.push(page.output);
        }
        continue;
      }
      components.push({ name, module, eager });
    }
    components.sort((a, b) => (a.name < b.name ? -1 : 1));

    const text: EntryText = {
      components,
      ...(options.providers === undefined
        ? {}
        : { providers: options.providers }),
      ...(options.providersDigest === undefined
        ? {}
        : { providersDigest: options.providersDigest }),
    };
    const name = entryName(renderEntryModule(text));
    entries.push({
      locale: page.locale,
      path: page.path,
      id: `${VIRTUAL_PREFIX}${name}`,
      name,
      ...text,
    });
  }

  if (missing.size > 0) {
    throw new ConfigError(missingModuleReport([...missing.values()]));
  }

  entries.sort(beforePage);
  contentOnly.sort(beforePage);
  return { entries, contentOnly };
}

/**
 * Every component is imported dynamically, whatever its `eager` bit says. Under
 * `hot` the hydrate is guarded: Vite re-executes this module on each update.
 */
export function renderEntryModule(
  entry: EntryText,
  options: { hot?: boolean } = {},
): string {
  const hot = options.hot === true;
  const lines = [`import { hydrateIslands } from "@pagedeck/islands/runtime";`];
  if (hot) lines.push(`import { hotIslands } from "@pagedeck/islands/hmr";`);
  if (entry.providers !== undefined) {
    lines.push(`import providers from ${JSON.stringify(entry.providers)};`);
    if (entry.providersDigest !== undefined) {
      lines.push(
        `import { checkRootProviders } from "@pagedeck/islands/root-provider-check";`,
      );
    }
    lines.push(
      `import { checkSharedStore, markRootsMounting } from "@pagedeck/islands/store-stamp";`,
    );
    if (hot) {
      lines.push(
        `import { rootProviderProbe } from "@pagedeck/islands/root-provider-probe";`,
      );
    }
  }
  lines.push("const modules = {");
  for (const component of entry.components) {
    lines.push(
      `  ${JSON.stringify(component.name)}: () => import(${JSON.stringify(component.module)}),`,
    );
  }
  lines.push("};");
  if (hot) lines.push("const hot = hotIslands(import.meta.hot, modules);");

  const hydrate =
    entry.providers !== undefined && entry.providersDigest !== undefined
      ? [
          // Before the hydrate, so its report does not read as a consequence of
          // React's own hydration error.
          `checkRootProviders(providers, ${JSON.stringify(entry.providersDigest)});`,
        ]
      : [];
  if (entry.providers !== undefined) {
    // Written literally so Vite folds it per build (#252).
    hydrate.push(`checkSharedStore(providers, import.meta.env.PROD);`);
    // Last before the hydrate, where "before any root mounts" stops being true.
    hydrate.push("markRootsMounting();");
  }
  hydrate.push(
    "hydrateIslands({",
    hot
      ? "  resolve: hot.resolve,"
      : "  resolve: (name) => modules[name]().then((module) => module.default),",
  );
  if (entry.providers !== undefined) hydrate.push("  providers,");
  if (hot && entry.providers !== undefined) {
    hydrate.push("  probe: rootProviderProbe(),");
  }
  hydrate.push("});");

  if (hot) {
    lines.push(
      "if (!hot.hydrated) {",
      ...hydrate.map((line) => `  ${line}`),
      "}",
      "import.meta.hot.accept();",
    );
  } else lines.push(...hydrate);
  lines.push("");
  return lines.join("\n");
}
