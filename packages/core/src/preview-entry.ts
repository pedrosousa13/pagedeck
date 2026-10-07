import { ConfigError } from "./exit.js";
import type { ModuleMap } from "./entries.js";
import { getComponent } from "@pagedeck/islands";
import type {
  ComponentRegistry,
  HydrationMode,
  ModuleFacts,
} from "@pagedeck/islands";

export interface PreviewComponent {
  name: string;
  module: string;
  hydrate?: HydrationMode;
}

export interface PreviewEntry {
  id: string;
  name: string;
  components: readonly PreviewComponent[];
  modules: Readonly<Record<string, ModuleFacts>>;
  providers?: string;
  bridge?: string;
}

export interface PlanPreviewOptions {
  modules: ModuleMap;
  facts?: Readonly<Record<string, ModuleFacts>>;
  providers?: string;
  bridge?: string;
}

const PREVIEW_PREFIX = "\0fw:preview/";

const PREVIEW_NAME = "preview";

const MISSING_MODULE_FIX = {
  one: "the preview target loads the whole registry, so a component no page renders still needs a specifier: pass its specifier in planPreview's modules option, or drop it from the registry passed to planPreview",
  many: "the preview target loads the whole registry, so a component no page renders still needs a specifier: pass each one's specifier in planPreview's modules option, or drop each from the registry passed to planPreview",
} as const;

const SUBJECT = "Preview entry: ";

function missingModuleReport(missing: readonly string[]): string {
  const count = missing.length;
  const headline =
    count === 1
      ? `1 component has no module to import — ${MISSING_MODULE_FIX.one}`
      : `${String(count)} components have no module to import — ${MISSING_MODULE_FIX.many}`;
  const detail = missing.map((name) => `  "${name}"`).join("\n");
  return `${SUBJECT}${headline}:\n${detail}`;
}

export function planPreview(
  registry: ComponentRegistry,
  options: PlanPreviewOptions,
): PreviewEntry {
  const names = Object.keys(registry).sort();
  const components: PreviewComponent[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (!Object.hasOwn(options.modules, name)) {
      missing.push(name);
      continue;
    }
    const { hydrate } = getComponent(registry, name) ?? {};
    components.push({
      name,
      module: options.modules[name] as string,
      ...(hydrate === undefined ? {} : { hydrate }),
    });
  }
  if (missing.length > 0) throw new ConfigError(missingModuleReport(missing));

  const facts = options.facts ?? {};
  const modules: Record<string, ModuleFacts> = {};
  for (const name of Object.keys(facts).sort()) {
    if (Object.hasOwn(facts, name)) modules[name] = facts[name] as ModuleFacts;
  }

  return {
    id: `${PREVIEW_PREFIX}app`,
    name: PREVIEW_NAME,
    components,
    modules,
    ...(options.providers === undefined
      ? {}
      : { providers: options.providers }),
    ...(options.bridge === undefined ? {} : { bridge: options.bridge }),
  };
}

export function renderPreviewModule(entry: PreviewEntry): string {
  const lines = [`import { mountPreview } from "@pagedeck/preview";`];
  if (entry.bridge !== undefined) {
    lines.push(`import bridge from ${JSON.stringify(entry.bridge)};`);
  }
  if (entry.providers !== undefined) {
    lines.push(`import providers from ${JSON.stringify(entry.providers)};`);
    lines.push(`import { checkSharedStore } from "@pagedeck/islands/store-stamp";`);
  }
  lines.push("const registry = {");
  for (const component of entry.components) {
    const hydrate =
      component.hydrate === undefined
        ? ""
        : `, hydrate: ${JSON.stringify(component.hydrate)}`;
    lines.push(
      `  ${JSON.stringify(component.name)}: { import: () => import(${JSON.stringify(component.module)})${hydrate} },`,
    );
  }
  lines.push("};");
  // `false`, not `import.meta.env.PROD`: this bundle is a production Vite
  // build, yet preview must refuse a duplicate store as `pagedeck dev` does (#252).
  if (entry.providers !== undefined) {
    lines.push("checkSharedStore(providers, false);");
  }
  lines.push("mountPreview({");
  lines.push("  registry,");
  lines.push(`  modules: ${JSON.stringify(entry.modules)},`);
  if (entry.providers !== undefined) lines.push("  providers,");
  if (entry.bridge !== undefined) lines.push("  bridge,");
  lines.push("});", "");
  return lines.join("\n");
}
