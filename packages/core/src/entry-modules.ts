import { renderEntryModule } from "./entries.js";
import type { EntryPlan } from "./entries.js";
import { renderPreviewModule } from "./preview-entry.js";
import type { PreviewEntry } from "./preview-entry.js";
import type { Plugin } from "vite";

export function serveEntryModules(
  plan: EntryPlan,
  origin: string,
  globalCss: readonly string[] = [],
): Plugin {
  const global = globalCss
    .map((path) => `import ${JSON.stringify(path)};\n`)
    .join("");
  return serveGeneratedEntries(
    new Map(
      plan.entries.map((entry) => [
        entry.id,
        `${global}${renderEntryModule(entry)}`,
      ]),
    ),
    origin,
  );
}

export function servePreviewEntry(entry: PreviewEntry, origin: string): Plugin {
  return serveGeneratedEntries(
    new Map([[entry.id, renderPreviewModule(entry)]]),
    origin,
  );
}

export function serveGeneratedEntries(
  sources: ReadonlyMap<string, string>,
  origin: string,
): Plugin {
  return {
    name: "pagedeck:entry-modules",

    resolveId(source, importer) {
      if (sources.has(source)) return source;
      if (importer !== undefined && sources.has(importer)) {
        return this.resolve(source, origin);
      }
      return undefined;
    },

    load(id) {
      return sources.get(id);
    },
  };
}

export function entryInputs(plan: EntryPlan): Record<string, string> {
  return Object.fromEntries(
    plan.entries.map((entry) => [entry.name, entry.id]),
  );
}

export function previewInput(entry: PreviewEntry): Record<string, string> {
  return { [entry.name]: entry.id };
}
