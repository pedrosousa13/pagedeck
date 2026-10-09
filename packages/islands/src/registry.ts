export type HydrationMode = "none" | "load" | "visible" | "idle" | "interaction";

export interface ComponentDefinition {
  import: () => Promise<unknown>;
  hydrate?: HydrationMode;
}

export interface ComponentPath {
  path: string;
  hydrate?: HydrationMode;
}

export type ComponentDeclaration = string | ComponentPath;

export type ComponentRegistry<N extends string = string> = Readonly<
  Record<N, ComponentDefinition>
>;

export type ComponentDeclarations<N extends string = string> = Readonly<
  Record<N, ComponentDeclaration>
>;

export interface PageContext {
  locale: string;
  // Typed with the leading slash so a fixture that drops it fails typecheck (#171).
  path: `/${string}`;
}

// Not `@pagedeck/content`'s `EntryId`: this takes a rooted route and returns the
// string a message prints.
export function entryId(page: PageContext): string {
  return `/${page.locale}${page.path}`;
}

export interface ModuleFacts {
  useClient: boolean;
}

// Not `ConfigError`, which lives in `@pagedeck/core`, a consumer of this package.
export class RegistryError extends Error {
  override readonly name = "RegistryError";
}

const HYDRATION_MODES: readonly HydrationMode[] = [
  "none",
  "load",
  "visible",
  "idle",
  "interaction",
];

const MODE_LIST = '"none", "load", "visible", "idle" or "interaction"';

const PATH_FIX =
  'name its module by a path relative to the config file, such as "./components/<module>.tsx", or by a package specifier, such as "<package>/<module>"';

function pathFault(path: unknown): string | undefined {
  if (typeof path !== "string") {
    return `path is a ${typeof path}, not a string — ${PATH_FIX}`;
  }
  if (path === "") return `path is empty — ${PATH_FIX}`;
  if (path.trim() === "") return `path is only whitespace — ${PATH_FIX}`;
  return undefined;
}

function definitionFault(definition: unknown): string | undefined {
  if (typeof definition === "string") return pathFault(definition);
  if (typeof definition !== "object" || definition === null) {
    const found = definition === null ? "null" : typeof definition;
    return `is ${found}, not a component definition — ${PATH_FIX}`;
  }
  const entry = definition as Partial<ComponentPath & ComponentDefinition>;
  if (entry.import !== undefined) {
    return entry.path === undefined
      ? `declares a loader, import, which was removed — ${PATH_FIX}`
      : "declares both path and import, and import was removed — keep path and drop import";
  }
  if (entry.path === undefined) return `declares no path — ${PATH_FIX}`;
  const fault = pathFault(entry.path);
  if (fault !== undefined) return fault;
  if (
    entry.hydrate !== undefined &&
    !HYDRATION_MODES.includes(entry.hydrate as HydrationMode)
  ) {
    return `hydrate "${String(entry.hydrate)}" is not a hydration mode — use ${MODE_LIST}`;
  }
  return undefined;
}

export function componentFaults(
  components: object,
): string[] {
  return Object.entries(components).flatMap(([name, definition]) => {
    const fault = definitionFault(definition);
    return fault === undefined ? [] : [`"${name}": ${fault}`];
  });
}

export function defineComponents<
  T extends Readonly<Record<string, ComponentDeclaration>>,
>(components: T): ComponentDeclarations<Extract<keyof T, string>> {
  const faults = componentFaults(components);
  if (faults.length > 0) {
    const subject =
      faults.length === 1
        ? "1 component is"
        : `${faults.length} components are`;
    throw new RegistryError(
      `Component registry: ${subject} not usable — fix each one:\n${faults.map((fault) => `  ${fault}`).join("\n")}`,
    );
  }
  return components;
}

let installedWarn: ((message: string) => void) | undefined;

// Restores the previous sink rather than `console.warn`, because two `runCli`
// runs can overlap in one process (#184).
export function installRegistryWarnings(
  sink: (message: string) => void,
): () => void {
  const previous = installedWarn;
  installedWarn = sink;
  return () => {
    installedWarn = previous;
  };
}

export function mergeComponents<
  A extends string,
  B extends string,
  D extends ComponentDeclaration,
>(
  base: Readonly<Record<A, D>>,
  local: Readonly<Record<B, D>>,
  options: { warn?: (message: string) => void } = {},
): Readonly<Record<A | B, D>> {
  const warn = options.warn ?? installedWarn ?? console.warn;
  const merged: Record<string, D> = { ...base };
  for (const [name, definition] of Object.entries<D>(local)) {
    if (Object.hasOwn(merged, name)) {
      warn(
        `Component "${name}": registered by two merged registries — the later one wins and the earlier one is unreachable; rename one of them, or drop the merge`,
      );
    }
    merged[name] = definition;
  }
  return merged as Readonly<Record<A | B, D>>;
}

export function getComponent<D extends ComponentDeclaration | ComponentDefinition>(
  registry: Readonly<Record<string, D>>,
  name: string,
): D | undefined {
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

export function resolveComponent<
  D extends ComponentDeclaration | ComponentDefinition,
>(
  registry: Readonly<Record<string, D>>,
  name: string,
  page: PageContext,
): D {
  const definition = getComponent(registry, name);
  if (definition === undefined) {
    throw new RegistryError(
      `Component "${name}": not registered, and entry ${entryId(page)} references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry`,
    );
  }
  return definition;
}

export const HYDRATION_CONTRADICTION_FIX =
  'a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module';

export function hydrationContradiction(name: string, where: string): string {
  return `Component "${name}": its module carries "use client" but the registry declares hydrate: "none", and ${where} — ${HYDRATION_CONTRADICTION_FIX}`;
}

export type HydrationSource = "declared" | "defaulted";

export interface ResolvedHydration {
  mode: HydrationMode;
  source: HydrationSource;
}

export function resolveHydrationMode(
  registry: Readonly<Record<string, ComponentDeclaration | ComponentDefinition>>,
  name: string,
  page: PageContext,
  module: ModuleFacts,
): ResolvedHydration {
  const declaration = resolveComponent(registry, name, page);
  const hydrate =
    typeof declaration === "string" ? undefined : declaration.hydrate;
  if (hydrate === undefined) {
    return {
      mode: module.useClient ? "visible" : "none",
      source: "defaulted",
    };
  }
  if (hydrate === "none" && module.useClient) {
    throw new RegistryError(
      hydrationContradiction(name, `entry ${entryId(page)} renders it`),
    );
  }
  return { mode: hydrate, source: "declared" };
}
