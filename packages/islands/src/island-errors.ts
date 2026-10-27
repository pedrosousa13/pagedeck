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
  /** The build id: the `build.id` in this build's `manifest.json`. */
  readonly release: string;
  readonly error: unknown;
}

export type IslandErrorReporter = (report: IslandErrorReport) => void;

export interface IslandErrors {
  readonly hydrateRoot: typeof hydrateRoot;
  /** Also fixes the release every later report names. */
  resolve<T>(
    release: string,
    load: (name: string) => Promise<T>,
  ): (name: string) => Promise<T>;
}

// Not the `DOM` lib, which would type `document` in node-only packages.
interface Browser {
  document: { documentElement: { lang: string } };
  location: { pathname: string };
  reportError?: (error: unknown) => void;
}
const browser = globalThis as unknown as Browser;

// React's own defaults when no callback is passed (react-dom 19.2).
function reportGlobally(error: unknown): void {
  if (typeof browser.reportError === "function") browser.reportError(error);
  else console.error(error);
}

export function reportIslandErrors(
  hydrate: typeof hydrateRoot,
  reporter: IslandErrorReporter,
): IslandErrors {
  let release = "";
  let reporting = false;
  const report = (
    kind: IslandErrorKind,
    component: string,
    error: unknown,
  ): void => {
    if (reporting) return;
    reporting = true;
    try {
      reporter({
        kind,
        page: {
          locale: browser.document.documentElement.lang,
          path: browser.location.pathname,
        },
        component,
        release,
        error,
      });
    } catch (failure) {
      console.error(failure);
    } finally {
      reporting = false;
    }
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
    resolve: (id, load) => {
      release = id;
      return (name) =>
        load(name).catch((error: unknown) => {
          report("module-load", name, error);
          throw error;
        });
    },
  };
}
