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
import type { PluginOption } from "vite";
import type { ModuleMap } from "./entries.js";
import { ConfigError } from "./exit.js";
import {
  COMPONENT_FIELD,
  resolutionFailure,
  threwFault,
} from "./resolve-faults.js";
import type { ResolutionFault } from "./resolve-faults.js";

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
  plugins?: readonly PluginOption[],
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

  const faults = new Map<string, { line?: string; fault: ResolutionFault }>();
  for (const { name, path, hydrate } of files) {
    const file = resolve(root, path);
    if (!isFile(file)) {
      faults.set(name, {
        line: `  "${name}" — "${path}" resolves to "${file}", and no file is there`,
        fault: {
          lead: `"${name}" — "${path}"`,
          what: `resolves to "${file}", and no file is there`,
          fix: "point its path at a file, relative to this config file",
        },
      });
      continue;
    }
    registry[name] = loader(file, hydrate);
    derived[name] = moduleSpecifier(root, file);
  }

  let threw = false;
  if (packages.length > 0) {
    const { resolveComponentModules } = await import("./island-facts.js");
    const { ids, thrown } = await resolveComponentModules(
      [...new Set(packages.map(({ path }) => path))],
      { root, origin: configPath, plugins },
    );
    for (const { name, path, hydrate } of packages) {
      const lead = `"${name}" — "${path}"`;
      const failed = thrown.find(({ specifier }) => specifier === path);
      if (failed !== undefined) {
        threw = true;
        faults.set(name, {
          fault: threwFault(lead, failed.error, COMPONENT_FIELD),
        });
        continue;
      }
      const id = Object.hasOwn(ids, path) ? ids[path] : undefined;
      if (id === undefined || !isAbsolute(id)) {
        faults.set(name, {
          line: `  ${lead} resolves to no module from "${configPath}"`,
          fault: {
            lead,
            what: "resolves to no module",
            fix: "install the package its specifier names",
          },
        });
        continue;
      }
      registry[name] = loader(id, hydrate);
      derived[name] = path;
    }
  }

  if (faults.size > 0) {
    const held = Object.keys(declared).flatMap((name) => {
      const held = faults.get(name);
      return held === undefined ? [] : [held];
    });
    if (threw) {
      throw resolutionFailure({
        where: `Config "${configPath}"`,
        noun: { one: "component", many: "components" },
        faults: held.map(({ fault }) => fault),
      });
    }
    throw new ConfigError(
      unresolvedReport(
        held.flatMap(({ line }) => (line === undefined ? [] : [line])),
        configPath,
      ),
    );
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
