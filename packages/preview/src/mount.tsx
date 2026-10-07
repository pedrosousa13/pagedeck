import { createElement, Suspense } from "react";
import type { ReactElement, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { buildPageTree } from "@pagedeck/core/tree";
import type { ModuleFacts, ComponentRegistry, RootProvider } from "@pagedeck/islands";
import { readDraft } from "./draft.js";
import { PreviewParityError, previewIsland } from "./parity.js";
import { PREVIEW_REGIONS } from "./region.js";

/**
 * `packages/core/src/preview-build.test.ts` searches production chunks for this. It marks
 * the mount container, which keeps it load-bearing.
 */
export const PREVIEW_MARK = "fw-preview-build-target";

/** Where the mark is written, and the element `mountPreview` looks for. */
export const PREVIEW_ATTRIBUTE = "data-fw-preview";

/** The element a preview app mounts into when the caller names none. */
export const PREVIEW_CONTAINER_ID = "fw-preview";

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
export interface PreviewContainer {
  setAttribute(name: string, value: string): void;
}

interface Browser {
  document: { getElementById(id: string): PreviewContainer | null };
}

const browser = globalThis as unknown as Browser;

/** Subscribe to draft payloads; the returned function stops. Everything else is the adapter's. */
export interface PreviewBridge {
  subscribe(onDraft: (payload: unknown) => void): () => void;
}

export interface MountPreviewOptions {
  /** The whole registry: preview cannot know which components a draft will name. */
  registry: ComponentRegistry;
  /** The build's directive scan, so slot constraints apply to the nodes production would island. */
  modules?: Readonly<Record<string, ModuleFacts>>;
  providers?: readonly RootProvider[];
  /** The CMS adapter, when the deployment has one wired (#54). */
  bridge?: PreviewBridge;
  /** Where to mount. Defaults to the element with id `fw-preview`. */
  container?: PreviewContainer;
  /** Defaults to rethrowing in a fresh microtask, so a refusal is never swallowed. */
  onError?: (error: unknown, payload: unknown) => void;
}

export interface PreviewHandle {
  /**
   * Resolves when the draft is in the DOM; rejects with any refusal it produced (payload,
   * render or slot parity), several as an `AggregateError`. Bridge events report to `onError`.
   */
  render(payload: unknown): Promise<void>;
  /** Unsubscribe from the bridge and unmount. */
  stop(): void;
}

// Stricter than production on purpose: a build's suspension watchdog needs Node's microtask
// ordering, so a browser refuses to show the fallback instead.
function SuspendedDraft(): ReactElement {
  throw new PreviewParityError(
    `Preview draft: a component suspended on data the framework did not resolve — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection's loader and read it with useBuildData()`,
  );
}

function mounted(tree: ReactNode): ReactElement {
  return createElement(Suspense, { fallback: createElement(SuspendedDraft) }, tree);
}

export function mountPreview(options: MountPreviewOptions): PreviewHandle {
  const container = options.container ?? findContainer();
  container.setAttribute(PREVIEW_ATTRIBUTE, PREVIEW_MARK);

  let current: unknown;

  const report =
    options.onError ??
    ((error: unknown): void => {
      // Rethrown outside any `catch`, so the browser reports it as uncaught.
      queueMicrotask(() => {
        throw error;
      });
    });

  // React reports a throwing component on the root's error channel, not out of `root.render`;
  // this is the window in which a refusal belongs to the commit `render` asked for.
  let committing: unknown[] | undefined;

  const route = (error: unknown): void => {
    if (committing === undefined) report(error, current);
    else committing.push(error);
  };
  const root = createRoot(container as Parameters<typeof createRoot>[0], {
    onUncaughtError: route,
    onCaughtError: route,
  });

  // Tree builds are async, so drafts can settle out of order; a superseded result is dropped.
  let generation = 0;

  const render = async (payload: unknown): Promise<void> => {
    const draft = readDraft(payload);
    const at = (generation += 1);
    const tree = await buildPageTree({
      page: draft.page,
      content: draft.content,
      // Merged last, so a site cannot redefine the reserved `fw-` region name (#54).
      registry: { ...options.registry, ...PREVIEW_REGIONS },
      ...(draft.locale === undefined ? {} : { locale: draft.locale }),
      ...(draft.data === undefined ? {} : { data: draft.data }),
      ...(options.modules === undefined ? {} : { modules: options.modules }),
      ...(options.providers === undefined
        ? {}
        : { providers: options.providers }),
      wrapIsland: previewIsland,
    });
    if (at !== generation) return;
    current = payload;
    // Synchronous, so the returned promise settles on a DOM the draft is really in.
    const refusals: unknown[] = [];
    committing = refusals;
    try {
      flushSync(() => {
        root.render(mounted(tree));
      });
    } finally {
      committing = undefined;
    }
    if (refusals.length > 0) throw commitFailure(refusals);
  };

  const unsubscribe = options.bridge?.subscribe((payload: unknown) => {
    void render(payload).catch((error: unknown) => {
      report(error, payload);
    });
  });

  return {
    render,
    stop() {
      unsubscribe?.();
      root.unmount();
    },
  };
}

// One refusal keeps its class; several become the `AggregateError` React itself produces.
function commitFailure(refusals: readonly unknown[]): unknown {
  const [only] = refusals;
  if (refusals.length === 1) return only;
  return new AggregateError(
    refusals,
    `Preview draft: ${String(refusals.length)} components refused to render it — every refusal is on this error's "errors", and each names the component to fix`,
  );
}

function findContainer(): PreviewContainer {
  const found = browser.document.getElementById(PREVIEW_CONTAINER_ID);
  if (found === null) {
    throw new Error(
      `Preview app: the page has no element with id "${PREVIEW_CONTAINER_ID}" to mount into — add one to the preview deployment's HTML, or pass mountPreview() a container`,
    );
  }
  return found;
}
