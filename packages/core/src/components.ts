import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ComponentDeclaration,
  ComponentDeclarations,
  ComponentDefinition,
  ComponentRegistry,
  HydrationMode,
} from "@pagedeck/islands";
import type { ModuleMap } from "./entries.js";
import { ConfigError } from "./exit.js";

export interface SiteComponents {
  readonly registry: ComponentRegistry;
  readonly modules: ModuleMap;
}

function isFilePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../") || isAbsolute(path);
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Relative and `./`-led, so the client build reads it as a file, not a package. */
function moduleSpecifier(root: string, file: string): string {
  const inside = relative(root, file).split(sep).join("/");
  return inside.startsWith("../") ? inside : `./${inside}`;
}

function loader(
  file: string,
  hydrate: HydrationMode | undefined,
): ComponentDefinition {
  const url = pathToFileURL(file).href;
  return {
    import: () => import(url),
    ...(hydrate === undefined ? {} : { hydrate }),
  };
}

interface Declared {
  name: string;
  path: string;
  hydrate: HydrationMode | undefined;
}

export async function deriveComponents(
  declared: ComponentDeclarations,
  configPath: string,
): Promise<SiteComponents> {
  const root = dirname(configPath);
  const registry: Record<string, ComponentDefinition> = {};
  const derived: Record<string, string> = {};
  const files: Declared[] = [];
  const packages: Declared[] = [];
  for (const [name, declaration] of Object.entries<ComponentDeclaration>(
    declared,
  )) {
    const one =
      typeof declaration === "string"
        ? { name, path: declaration, hydrate: undefined }
        : { name, path: declaration.path, hydrate: declaration.hydrate };
    (isFilePath(one.path) ? files : packages).push(one);
  }

  const faults = new Map<string, string>();
  for (const { name, path, hydrate } of files) {
    const file = resolve(root, path);
    if (!isFile(file)) {
      faults.set(
        name,
        `  "${name}" — "${path}" resolves to "${file}", and no file is there`,
      );
      continue;
    }
    registry[name] = loader(file, hydrate);
    derived[name] = moduleSpecifier(root, file);
  }

  if (packages.length > 0) {
    const { resolveComponentModules } = await import("./island-facts.js");
    const { ids } = await resolveComponentModules(
      [...new Set(packages.map(({ path }) => path))],
      { root, origin: configPath },
    );
    for (const { name, path, hydrate } of packages) {
      const id = Object.hasOwn(ids, path) ? ids[path] : undefined;
      if (id === undefined || !isAbsolute(id)) {
        faults.set(
          name,
          `  "${name}" — "${path}" resolves to no module from "${configPath}"`,
        );
        continue;
      }
      registry[name] = loader(id, hydrate);
      derived[name] = path;
    }
  }

  if (faults.size > 0) {
    const lines = Object.keys(declared).flatMap((name) => {
      const line = faults.get(name);
      return line === undefined ? [] : [line];
    });
    throw new ConfigError(unresolvedReport(lines, configPath));
  }
  return { registry, modules: derived };
}

function unresolvedReport(faults: readonly string[], configPath: string): string {
  const one = faults.length === 1;
  return `Config "${configPath}": ${
    one ? "1 component declares" : `${String(faults.length)} components declare`
  } a module that does not resolve — point ${
    one ? "its path" : "each path"
  } at a file, relative to this config file, or install the package ${
    one ? "its" : "each"
  } specifier names:\n${faults.join("\n")}`;
}
