import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";

export interface RootProvider {
  component: ComponentType<never>;
  props?: Readonly<Record<string, unknown>>;
}

type AnyComponent = ComponentType<Record<string, unknown>>;

export interface RootProviderProbe {
  element(provider: RootProvider, children: ReactNode): ReactNode;
}

// Not `checkRootProviders`, which a stackless site must not load. `memo`,
// `forwardRef` and `lazy` all return objects.
function renderable(providers: readonly RootProvider[]): boolean {
  if (!Array.isArray(providers)) return false;
  return providers.every((provider) => {
    if (typeof provider !== "object" || provider === null) return false;
    const component = (provider as RootProvider).component as unknown;
    return (
      typeof component === "function" ||
      (typeof component === "object" && component !== null)
    );
  });
}

// A malformed stack is applied as no stack, never as its usable part: a partial
// wrap is a third stack neither half of `build.rootProviders` declares.
export function wrapInProviders(
  tree: ReactNode,
  providers: readonly RootProvider[],
  probe?: RootProviderProbe,
): ReactNode {
  if (!renderable(providers)) return tree;
  let wrapped = tree;
  for (let at = providers.length - 1; at >= 0; at -= 1) {
    const provider = providers[at] as RootProvider;
    wrapped =
      probe === undefined
        ? createElement(
            provider.component as AnyComponent,
            { ...provider.props },
            wrapped,
          )
        : probe.element(provider, wrapped);
  }
  return wrapped;
}
