import { createContext, createElement, useContext, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  entryId,
  hydrationContradiction,
  HYDRATION_CONTRADICTION_FIX,
  RegistryError,
} from "@pagedeck/islands";
import type { HydrationMode, PageContext } from "@pagedeck/islands";
import {
  CLIENT_REFERENCE_TARGET,
  islandMarker,
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
}

export interface ProxyInstance {
  prefix: string;
  name: string;
  mode: Exclude<HydrationMode, "none">;
  component: AnyComponent;
  props: Readonly<Record<string, unknown>>;
  hasChildren: boolean;
  renderedBy: string | undefined;
}

/**
 * What React renders nothing for is not children: an empty list or a false
 * conditional must not be refused. `0` and `""` render, so they are children.
 */
function rendersChildren(children: unknown): boolean {
  if (children === undefined || children === null) return false;
  if (typeof children === "boolean") return false;
  if (Array.isArray(children)) return children.some(rendersChildren);
  return true;
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
);

const ProxyScopeContext = createContext<ProxyScope | undefined>(undefined);

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
  const { name, mode } = options;
  const real = component as unknown as AnyComponent;

  function ClientReferenceProxy(props: Record<string, unknown>) {
    const scope = useContext(ProxyScopeContext);
    const id = useId();
    if (scope === undefined) return createElement(real, props);

    // Before a prefix is derived: this instance is not becoming an island.
    if (mode === "none") {
      if (scope.phase === "collect") {
        const contradiction = scope.contradictions.get(name);
        if (contradiction === undefined) {
          scope.contradictions.set(name, {
            component: name,
            renderedBy: new Set([scope.renderedBy]),
          });
        } else {
          contradiction.renderedBy.add(scope.renderedBy);
        }
      }
      return null;
    }

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
    const { children, ...rest } = props;
    scope.collected.set(prefix, {
      prefix,
      name,
      mode,
      component: real,
      props: rest,
      hasChildren: rendersChildren(children),
      renderedBy: scope.renderedBy,
    });
    // Renders nothing, which is also what ends the recursion: a nested proxy
    // waits for this instance's own pass.
    return null;
  }

  Object.defineProperty(ClientReferenceProxy, CLIENT_REFERENCE_TARGET, {
    value: real,
  });
  return ClientReferenceProxy as (props: P) => ReactElement | null;
}

export interface RefusedChildren {
  component: string;
  renderedBy: string | undefined;
}

export interface ProxyFaults {
  duplicates: DuplicateProxy[];
  unserializable: PropsFailure[];
  refused: RefusedProp[];
  children: RefusedChildren[];
}

const PROXY_REFUSED_FIX =
  "a client component's props are the code of whatever rendered it, and the build hands them to React unchanged and its marker carries them to the browser";

const PROXY_CHILDREN_FIX =
  'a client component\'s children are slots, and a slot is identified by its position in the entry tree, which a component\'s own JSX has none of — place the component as a node in the entry tree, where its children become slots, or move "use client" down to the interactive leaves so the wrapper stays a server component';

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
  faults.refused.length +
  faults.children.length;

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
  const [refused] = faults.refused;
  if (refused !== undefined) {
    return new RenderError(
      `Component "${refused.component}": prop "${refused.path}" is ${refused.problem}, and ${proxyWhere(refused.renderedBy, page)} — ${refused.reason ?? PROXY_REFUSED_FIX}, so ${refused.fix}`,
    );
  }
  const child = faults.children[0] as RefusedChildren;
  return new RenderError(
    `Component "${child.component}": is given JSX children, and ${proxyWhere(child.renderedBy, page)} — ${PROXY_CHILDREN_FIX}`,
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
  if (faults.children.length > 0) {
    const many = faults.children.length > 1;
    sections.push(
      paragraph(
        page,
        `${String(faults.children.length)} client ${many ? "components are" : "component is"} given JSX children`,
        PROXY_CHILDREN_FIX,
        faults.children.map((child) =>
          proxyNamed(child.component, child.renderedBy),
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
