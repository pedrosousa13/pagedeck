import type { hydrateRoot } from "react-dom/client";
import { ISLAND_COMPONENT_ATTRIBUTE } from "./marker.js";
import type { IslandElement } from "./runtime.js";

export type IslandErrorKind =
  | "recoverable"
  | "caught"
  | "uncaught"
  | "module-load";

export interface IslandErrorReport {
  readonly kind: IslandErrorKind;
  readonly page: { readonly locale: string; readonly path: string };
  /** The name the island is registered under in `build.components`. */
  readonly component: string;
  /**
   * `build.id` of the `/manifest.json` the host serves when the error is
   * reported. Absent when the host serves no readable one.
   */
  readonly release?: string;
  readonly error: unknown;
}

export type IslandErrorReporter = (
  report: IslandErrorReport,
) => void | Promise<void>;

export interface IslandErrors {
  readonly hydrateRoot: typeof hydrateRoot;
  resolve<T>(
    load: (name: string, exported: string | null) => Promise<T>,
  ): (name: string, exported: string | null) => Promise<T>;
}

// Not the `DOM` lib, which would type `document` in node-only packages.
interface Browser {
  document: { documentElement: { lang: string } };
  location: { pathname: string };
  reportError?: (error: unknown) => void;
  fetch(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}
const browser = globalThis as unknown as Browser;

// React's own defaults when no callback is passed (react-dom 19.2).
function reportGlobally(error: unknown): void {
  if (typeof browser.reportError === "function") browser.reportError(error);
  else console.error(error);
}

const MANIFEST_PATH = "/manifest.json";

function readRelease(): Promise<string | undefined> {
  return browser
    .fetch(MANIFEST_PATH)
    .then((response) => (response.ok ? response.json() : undefined))
    .then((manifest) => {
      const id = (manifest as { build?: { id?: unknown } } | null | undefined)
        ?.build?.id;
      return typeof id === "string" ? id : undefined;
    })
    .catch(() => undefined);
}

export function reportIslandErrors(
  hydrate: typeof hydrateRoot,
  loadReporter: () => Promise<{ default: IslandErrorReporter }>,
): IslandErrors {
  const reporter = loadReporter().then(
    (module) => module.default,
    (failure: unknown) => {
      console.error(failure);
      return undefined;
    },
  );
  let release: Promise<string | undefined> | undefined;
  const report = (
    kind: IslandErrorKind,
    component: string,
    error: unknown,
  ): void => {
    const page = {
      locale: browser.document.documentElement.lang,
      path: browser.location.pathname,
    };
    void reporter.then(async (send) => {
      if (send === undefined) return;
      const id = await (release ??= readRelease());
      try {
        await send({
          kind,
          page,
          component,
          ...(id === undefined ? {} : { release: id }),
          error,
        });
      } catch (failure) {
        console.error(failure);
      }
    });
  };

  return {
    hydrateRoot: (container, children, options) => {
      const component =
        (container as unknown as IslandElement).getAttribute(
          ISLAND_COMPONENT_ATTRIBUTE,
        ) ?? "";
      return hydrate(container, children, {
        ...options,
        onRecoverableError: (error) => {
          report("recoverable", component, error);
          reportGlobally(error);
        },
        onCaughtError: (error) => {
          report("caught", component, error);
          console.error(error);
        },
        onUncaughtError: (error) => {
          report("uncaught", component, error);
          reportGlobally(error);
        },
      });
    },
    resolve: (load) => (name, exported) =>
      load(name, exported).catch((error: unknown) => {
        report("module-load", name, error);
        throw error;
      }),
  };
}
