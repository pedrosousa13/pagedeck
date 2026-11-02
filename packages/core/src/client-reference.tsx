import {
  createContext,
  createElement,
  isValidElement,
  Suspense,
  useContext,
  useId,
} from "react";
import type { ReactElement, ReactNode } from "react";
import {
  entryId,
  hydrationContradiction,
  HYDRATION_CONTRADICTION_FIX,
  ISLAND_REGION_ATTRIBUTE,
  RegistryError,
} from "@pagedeck/islands";
import type { HydrationMode, PageContext, PropPath } from "@pagedeck/islands";
import {
  CLIENT_REFERENCE_TARGET,
  islandMarker,
  MAXIMUM_PROP_DEPTH,
  PROPS_FIX,
  RenderError,
} from "./tree.js";
import type {
  AnyComponent,
  ComposedIsland,
  PropsFailure,
  RefusedProp,
} from "./tree.js";

export interface ClientReferenceOptions {
  name: string;
  mode: HydrationMode;
  export?: string;
}

export interface ProxyInstance {
  prefix: string;
  name: string;
  export: string | undefined;
  mode: Exclude<HydrationMode, "none">;
  component: AnyComponent;
  props: Readonly<Record<string, unknown>>;
  serverProps: Readonly<Record<string, unknown>>;
  slots: readonly PropPath[];
  placed: ReadonlyMap<number, ReadonlySet<string>>;
  misplaced: readonly Omit<RefusedProp, "component">[];
  renderedBy: string | undefined;
}

interface PropSlotWalk {
  slots: PropPath[];
  placed: Map<number, Set<string>>;
  misplaced: Omit<RefusedProp, "component">[];
  ancestors: Map<object, PropHalves>;
}

interface PropHalves {
  server: unknown;
  json: unknown;
}

const MISPLACED_REASON =
  "a prop slot is found only in plain objects and arrays, and serializing any other container would drop the element silently";

const MISPLACED_FIX = "move the element into a plain object or array";

const UNPLACED_REASON =
  "a prop slot reaches the browser only as the HTML its region rendered";

const UNPLACED_FIX =
  "render the element in the component's server output, or pass it only when the component shows it";

const TWICE_REASON =
  "a prop slot has one region of server HTML and the browser keeps it where it is";

export function twicePlacedPropSlot(
  path: PropPath,
): Omit<RefusedProp, "component"> {
  return {
    path: path.join("."),
    problem: "an element the component renders in more than one place",
    fix: "render the element once",
    reason: TWICE_REASON,
  };
}

export function unplacedPropSlot(
  path: PropPath,
): Omit<RefusedProp, "component"> {
  return {
    path: path.join("."),
    problem: "an element the component does not render on the server",
    fix: UNPLACED_FIX,
    reason: UNPLACED_REASON,
  };
}

const isPlain = (value: object): boolean => {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

function holdsElement(value: unknown, depth: number, seen: Set<object>): boolean {
  if (isValidElement(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if (depth > MAXIMUM_PROP_DEPTH || seen.has(value)) return false;
  seen.add(value);
  const inner: unknown[] =
    value instanceof Map
      ? [...value.keys(), ...value.values()]
      : value instanceof Set
        ? [...value]
        : Object.values(Object.getOwnPropertyDescriptors(value)).map(
            (descriptor) => descriptor.value as unknown,
          );
  return inner.some((item) => holdsElement(item, depth + 1, seen));
}

const containerKind = (value: object): string =>
  value instanceof Map
    ? "a Map"
    : value instanceof Set
      ? "a Set"
      : "a class instance";

/**
 * Copies descriptors rather than values, so an accessor or a symbol key reaches
 * `refusedProps` unread. A cycle closes onto the copy, so it still fails JSON.
 */
function splitPropSlots(
  value: unknown,
  path: PropPath,
  walk: PropSlotWalk,
): PropHalves {
  if (isValidElement(value)) {
    const index = walk.slots.push(path) - 1;
    return { server: propSlotRegion(value, index, walk.placed), json: null };
  }
  if (typeof value !== "object" || value === null) {
    return { server: value, json: value };
  }
  const ancestor = walk.ancestors.get(value);
  if (ancestor !== undefined) return ancestor;
  if (path.length > MAXIMUM_PROP_DEPTH) return { server: value, json: value };
  if (!isPlain(value)) {
    if (holdsElement(value, path.length, new Set())) {
      walk.misplaced.push({
        path: path.join("."),
        problem: `${containerKind(value)} holding a React element`,
        fix: MISPLACED_FIX,
        reason: MISPLACED_REASON,
      });
    }
    return { server: value, json: value };
  }

  const emptyLike = (): object =>
    Array.isArray(value)
      ? []
      : (Object.create(Object.getPrototypeOf(value) as object | null) as object);
  const halves = { server: emptyLike(), json: emptyLike() };
  walk.ancestors.set(value, halves);
  const server: PropertyDescriptorMap = {};
  const json: PropertyDescriptorMap = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    // React's development build puts non-enumerable `key` and `ref` warning
    // getters on the props object itself.
    if (path.length === 0 && descriptor.enumerable !== true) continue;
    if (typeof key === "symbol" || !("value" in descriptor)) {
      server[key] = descriptor;
      json[key] = descriptor;
      continue;
    }
    const segment =
      Array.isArray(value) && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
    const part = splitPropSlots(descriptor.value, [...path, segment], walk);
    server[key] = { ...descriptor, value: part.server };
    json[key] = { ...descriptor, value: part.json };
  }
  walk.ancestors.delete(value);
  Object.defineProperties(halves.server, server);
  Object.defineProperties(halves.json, json);
  return halves;
}

// Counted by `useId`, which repeats across a pass's two runs and differs
// between two places in one tree.
function RegionMark({
  index,
  placed,
}: {
  index: number;
  placed: Map<number, Set<string>>;
}) {
  const id = useId();
  const places = placed.get(index);
  if (places === undefined) placed.set(index, new Set([id]));
  else places.add(id);
  return createElement("template", { [ISLAND_REGION_ATTRIBUTE]: String(index) });
}

// A region's content is the server wrapper's, not the island's: a client
// component inside it must become an island of its own.
function RegionScope({ children }: { children: ReactNode }) {
  const scope = useContext(ProxyScopeContext);
  const outer = scope?.phase === "island" ? scope.outer : undefined;
  return createElement(
    ProxyScopeContext.Provider,
    { value: outer ?? scope },
    children,
  );
}

function propSlotRegion(
  element: ReactElement,
  index: number,
  placed: Map<number, Set<string>>,
): ReactElement {
  return createElement(
    Suspense,
    { key: `pagedeck-prop-slot:${String(index)}`, fallback: null },
    createElement(RegionMark, { index, placed }),
    createElement(RegionScope, null, element),
  );
}

export type ProxyScope = {
  page: PageContext;
  derive: (id: string, name: string) => string;
  renderedBy: string | undefined;
} & (
  | {
      phase: "collect";
      collected: Map<string, ProxyInstance>;
      duplicates: DuplicateProxy[];
      contradictions: Map<string, ContradictedHydration>;
    }
  | { phase: "compose"; composed: ReadonlyMap<string, ComposedIsland> }
  | {
      phase: "island";
      contradictions: Map<string, ContradictedHydration> | undefined;
      outer: ProxyScope | undefined;
    }
);

const ProxyScopeContext = createContext<ProxyScope | undefined>(undefined);

function IslandScope({ children }: { children: ReactNode }) {
  const scope = useContext(ProxyScopeContext);
  return createElement(
    ProxyScopeContext.Provider,
    {
      value:
        scope === undefined
          ? undefined
          : {
              page: scope.page,
              derive: scope.derive,
              renderedBy: scope.renderedBy,
              phase: "island",
              contradictions:
                scope.phase === "compose" ? undefined : scope.contradictions,
              outer: scope.phase === "island" ? scope.outer : scope,
            },
    },
    children,
  );
}

/**
 * An island's own render: a client component it imports renders as itself,
 * as it does in the island's chunk, and has no marker of its own (#174).
 */
export function closeProxyScope(inner: ReactNode): ReactElement {
  return createElement(IslandScope, { children: inner });
}

export function openProxyScope(
  scope: ProxyScope,
  inner: ReactNode,
): ReactElement {
  return createElement(ProxyScopeContext.Provider, { value: scope }, inner);
}

export interface ContradictedHydration {
  component: string;
  renderedBy: Set<string | undefined>;
}

export interface DuplicateProxy {
  component: string;
  existing: string;
  renderedBy: string | undefined;
}

const DUPLICATE_PREFIX_FIX =
  "two islands under one prefix hydrate as two roots over one marker, so give one of them a position of its own by placing it as a node in the entry tree";

export function clientReference<P extends Record<string, unknown>>(
  component: (props: P) => ReactElement | null,
  options: ClientReferenceOptions,
): (props: P) => ReactElement | null {
  const { name, mode, export: exported } = options;
  const real = component as unknown as AnyComponent;

  function ClientReferenceProxy(props: Record<string, unknown>) {
    const scope = useContext(ProxyScopeContext);
    if (scope === undefined) return createElement(real, props);

    // Before a prefix is derived: this instance is not becoming an island.
    if (mode === "none") {
      const contradictions =
        scope.phase === "compose" ? undefined : scope.contradictions;
      const contradiction = contradictions?.get(name);
      if (contradiction !== undefined) {
        contradiction.renderedBy.add(scope.renderedBy);
      } else {
        contradictions?.set(name, {
          component: name,
          renderedBy: new Set([scope.renderedBy]),
        });
      }
      return null;
    }

    if (scope.phase === "island") return createElement(real, props);
    return createElement(ScopedProxy, { scope, props, mode });
  }

  // Apart from the proxy: a component that calls `useId` moves every id below
  // it, and inside an island this one must render as the browser does (#174).
  function ScopedProxy({
    scope,
    props,
    mode,
  }: {
    scope: Exclude<ProxyScope, { phase: "island" }>;
    props: Record<string, unknown>;
    mode: Exclude<HydrationMode, "none">;
  }) {
    const id = useId();
    const prefix = scope.derive(id, name);
    if (scope.phase === "compose") {
      const composed = scope.composed.get(prefix);
      if (composed === undefined) return null;
      return islandMarker(composed, prefix);
    }

    const existing = scope.collected.get(prefix);
    if (existing !== undefined) {
      if (existing.component !== real || existing.mode !== mode) {
        scope.duplicates.push({
          component: name,
          existing: existing.name,
          renderedBy: scope.renderedBy,
        });
      }
      return null;
    }
    const walk: PropSlotWalk = {
      slots: [],
      placed: new Map(),
      misplaced: [],
      ancestors: new Map(),
    };
    const halves = splitPropSlots(props, [], walk);
    scope.collected.set(prefix, {
      prefix,
      name,
      export: exported,
      mode,
      component: real,
      props: halves.json as Record<string, unknown>,
      serverProps: halves.server as Record<string, unknown>,
      slots: walk.slots,
      placed: walk.placed,
      misplaced: walk.misplaced,
      renderedBy: scope.renderedBy,
    });
    // Renders nothing: this instance's own pass renders it.
    return null;
  }

  Object.defineProperty(ClientReferenceProxy, CLIENT_REFERENCE_TARGET, {
    value: real,
  });
  return ClientReferenceProxy as (props: P) => ReactElement | null;
}

export interface ProxyFaults {
  duplicates: DuplicateProxy[];
  unserializable: PropsFailure[];
  refused: RefusedProp[];
}

const PROXY_REFUSED_FIX =
  "a client component's props are the code of whatever rendered it, and the build hands them to React unchanged and its marker carries them to the browser";

const proxyWhere = (
  renderedBy: string | undefined,
  page: PageContext,
): string =>
  renderedBy === undefined
    ? `entry ${entryId(page)} renders it`
    : `"${renderedBy}" renders it in entry ${entryId(page)}`;

const proxyNamed = (component: string, renderedBy: string | undefined): string =>
  renderedBy === undefined
    ? component
    : `${component}, rendered by ${renderedBy}`;

const contradictionPlaces = (
  renderedBy: ReadonlySet<string | undefined>,
  quote: boolean,
): readonly string[] =>
  [...renderedBy].map((by) =>
    by === undefined ? "the entry's own tree" : quote ? `"${by}"` : by,
  );

const listed = (parts: readonly string[]): string =>
  parts.length < 2
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${String(parts.at(-1))}`;

const contradictionWhere = (
  renderedBy: ReadonlySet<string | undefined>,
  page: PageContext,
): string => {
  if (renderedBy.size === 1 && renderedBy.has(undefined)) {
    return proxyWhere(undefined, page);
  }
  const places = contradictionPlaces(renderedBy, true);
  return `${listed(places)} ${places.length > 1 ? "render" : "renders"} it in entry ${entryId(page)}`;
};

const contradictionNamed = (contradiction: ContradictedHydration): string => {
  const { component, renderedBy } = contradiction;
  if (renderedBy.size === 1 && renderedBy.has(undefined)) return component;
  return `${component}, rendered by ${listed(contradictionPlaces(renderedBy, false))}`;
};

const paragraph = (
  page: PageContext,
  subject: string,
  fix: string,
  lines: readonly string[],
): string =>
  `Entry ${entryId(page)}: ${subject} — ${fix}:\n${lines
    .map((line) => `  ${line}`)
    .join("\n")}`;

const proxyFaultCount = (faults: ProxyFaults): number =>
  faults.duplicates.length +
  faults.unserializable.length +
  faults.refused.length;

function proxySentence(faults: ProxyFaults, page: PageContext): RenderError {
  const [duplicate] = faults.duplicates;
  if (duplicate !== undefined) {
    return new RenderError(
      `Component "${duplicate.component}": derives the same island prefix as "${duplicate.existing}", and ${proxyWhere(duplicate.renderedBy, page)} — ${DUPLICATE_PREFIX_FIX}`,
    );
  }
  const [unserializable] = faults.unserializable;
  if (unserializable !== undefined) {
    return new RenderError(
      `Component "${unserializable.component}": its props do not serialize to JSON, and ${proxyWhere(unserializable.renderedBy, page)} — ${PROPS_FIX}, so give it props that are JSON`,
      { cause: unserializable.error },
    );
  }
  const refused = faults.refused[0] as RefusedProp;
  return new RenderError(
    `Component "${refused.component}": prop "${refused.path}" is ${refused.problem}, and ${proxyWhere(refused.renderedBy, page)} — ${refused.reason ?? PROXY_REFUSED_FIX}, so ${refused.fix}`,
  );
}

export function throwProxyFaults(faults: ProxyFaults, page: PageContext): void {
  const count = proxyFaultCount(faults);
  if (count === 0) return;
  if (count === 1) throw proxySentence(faults, page);

  const sections: string[] = [];
  if (faults.duplicates.length > 0) {
    const many = faults.duplicates.length > 1;
    sections.push(
      paragraph(
        page,
        `${String(faults.duplicates.length)} client ${many ? "components derive" : "component derives"} an island prefix another instance already holds`,
        DUPLICATE_PREFIX_FIX,
        faults.duplicates.map(
          (duplicate) =>
            `${proxyNamed(duplicate.component, duplicate.renderedBy)}: the prefix of "${duplicate.existing}"`,
        ),
      ),
    );
  }
  if (faults.unserializable.length > 0) {
    const many = faults.unserializable.length > 1;
    sections.push(
      paragraph(
        page,
        `${String(faults.unserializable.length)} client ${many ? "components have" : "component has"} props that do not serialize to JSON`,
        `${PROPS_FIX}, so give ${many ? "them" : "it"} props that are JSON`,
        faults.unserializable.map(
          (failure) =>
            `${proxyNamed(failure.component, failure.renderedBy)}: ${failure.reason}`,
        ),
      ),
    );
  }
  if (faults.refused.length > 0) {
    sections.push(
      paragraph(
        page,
        `the framework refuses ${String(faults.refused.length)} ${faults.refused.length > 1 ? "props" : "prop"} on client components`,
        `${PROXY_REFUSED_FIX}, so rename, replace or flatten each one below`,
        faults.refused.map(
          (prop) =>
            `${proxyNamed(prop.component, prop.renderedBy)}: ${prop.path} is ${prop.problem} — ${prop.reason === undefined ? prop.fix : `${prop.reason}, so ${prop.fix}`}`,
        ),
      ),
    );
  }
  throw new RenderError(sections.join("\n\n"));
}

export function throwContradictedHydration(
  contradictions: ReadonlyMap<string, ContradictedHydration>,
  page: PageContext,
): void {
  const found = [...contradictions.values()];
  const [only] = found;
  if (only === undefined) return;
  if (found.length === 1) {
    throw new RegistryError(
      hydrationContradiction(
        only.component,
        contradictionWhere(only.renderedBy, page),
      ),
    );
  }
  throw new RegistryError(
    paragraph(
      page,
      `${String(found.length)} client components carry "use client" but are registered hydrate: "none"`,
      HYDRATION_CONTRADICTION_FIX,
      found.map(contradictionNamed),
    ),
  );
}
