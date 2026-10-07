import { useRef } from "react";
import { createElement, isValidElement } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import type { RootProvider, RootProviderProbe } from "./providers.js";
import { reportRootProviderFault } from "./root-provider-check.js";

const CONTEXT_TYPES = new Set<symbol>([
  Symbol.for("react.context"),
  Symbol.for("react.provider"),
]);

type PlainProvider = (props: Record<string, unknown>) => ReactNode;

function plain(component: ComponentType<never>): PlainProvider | undefined {
  if (typeof component !== "function") return undefined;
  const prototype = (component as { prototype?: { isReactComponent?: unknown } })
    .prototype;
  if (prototype?.isReactComponent !== undefined) return undefined;
  return component as unknown as PlainProvider;
}

function contextValue(rendered: ReactNode): { value: unknown } | undefined {
  if (!isValidElement(rendered)) return undefined;
  const type = (rendered as ReactElement).type as unknown;
  if (typeof type !== "object" || type === null) return undefined;
  const stamp = (type as { $$typeof?: symbol }).$$typeof;
  if (stamp === undefined || !CONTEXT_TYPES.has(stamp)) return undefined;
  return { value: (rendered.props as { value?: unknown }).value };
}

function label(component: ComponentType<never>): string {
  const named = component as { displayName?: string; name?: string };
  return named.displayName ?? named.name ?? "(anonymous)";
}

function perInstanceMessage(component: ComponentType<never>): string {
  const name = label(component);
  return `Root provider "${name}": delivers a different value to each island root, so two islands that look like they share state do not — the provider creates its own state instead of receiving one, so move that state to a module-level instance and pass it in, as { component: ${name}, props: { store } }; this is a warning and not a refusal because the page renders and only its behaviour is wrong, and because this probe sees only a provider whose component is a plain function returning a context element`;
}

function plainContainer(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (
    prototype === Object.prototype ||
    prototype === null ||
    prototype === Array.prototype
  ) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

// Looks one level into a plain container: a shared store usually arrives in a
// fresh per-root wrapper such as `value={{ store }}`.
function sameDelivered(one: unknown, other: unknown): boolean {
  if (Object.is(one, other)) return true;
  const left = plainContainer(one);
  const right = plainContainer(other);
  if (left === undefined || right === undefined) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
  );
}

interface Watched {
  first: { instance: object; value: unknown };
  reported: boolean;
}

export function rootProviderProbe(): RootProviderProbe {
  const watched = new Map<ComponentType<never>, Watched>();

  function record(
    component: ComponentType<never>,
    instance: object,
    value: unknown,
  ): void {
    const seen = watched.get(component);
    if (seen === undefined) {
      watched.set(component, { first: { instance, value }, reported: false });
      return;
    }
    // One root re-rendering refreshes its recorded value, so a shared value that
    // moved is not reported against a later root as a divergence.
    if (seen.first.instance === instance) {
      seen.first.value = value;
      return;
    }
    if (seen.reported) return;
    if (sameDelivered(seen.first.value, value)) return;
    seen.reported = true;
    reportRootProviderFault(perInstanceMessage(component));
  }

  return {
    element(provider: RootProvider, children: ReactNode): ReactNode {
      const component = plain(provider.component);
      if (component === undefined) {
        return createElement(
          provider.component as ComponentType<Record<string, unknown>>,
          { ...provider.props },
          children,
        );
      }
      return createElement(Probed, { provider, component, record, children });
    },
  };
}

interface ProbedProps {
  provider: RootProvider;
  component: PlainProvider;
  record: (
    component: ComponentType<never>,
    instance: object,
    value: unknown,
  ) => void;
  children: ReactNode;
}

// Calling the provider as a function is ordinary React: its hooks run on this
// fiber and the DOM is what an unprobed wrap renders.
function Probed({
  provider,
  component,
  record,
  children,
}: ProbedProps): ReactNode {
  const instance = useRef<object>({});
  const rendered = component({ ...provider.props, children });
  const found = contextValue(rendered);
  if (found !== undefined) {
    record(provider.component, instance.current, found.value);
  }
  return rendered;
}
