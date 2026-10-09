import { createElement, startTransition } from "react";
import type { ComponentType } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_ID_PATTERN,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
  ISLAND_TEMPLATE_TAG,
} from "./marker.js";
import { wrapInProviders } from "./providers.js";
import type { RootProvider, RootProviderProbe } from "./providers.js";
import { RegistryError } from "./registry.js";
import { schedule } from "./startup.js";
import type { Schedule } from "./startup.js";

export interface IslandElement extends IslandRoot {
  getAttribute(name: string): string | null;
  querySelector(selectors: string): IslandElement | null;
  readonly localName: string;
  readonly parentElement: IslandElement | null;
  readonly children: ArrayLike<IslandElement>;
  innerHTML: string;
  readonly content?: { readonly textContent: string | null };
  remove(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface IslandRoot {
  querySelectorAll(selectors: string): Iterable<IslandElement>;
}

// Not the `DOM` lib, which would type `document` in node-only packages.
interface Browser {
  document: IslandRoot;
}
const browser = globalThis as unknown as Browser;

type AnyComponent = ComponentType<Record<string, unknown>>;

export interface HydrateIslandsOptions {
  resolve: (name: string) => Promise<ComponentType<never>>;
  schedule?: Schedule;
  providers?: readonly RootProvider[];
  // A shape only: importing the probe's module would put it in production graphs.
  probe?: RootProviderProbe;
  root?: IslandRoot;
}

// Every slot is read and every stash removed before any island mounts: a mount
// that changed the DOM would race another container's hydration (#67).
export function hydrateIslands(options: HydrateIslandsOptions): void {
  const root = options.root ?? browser.document;
  const slots = new Map<IslandElement, Map<string, string>>();
  for (const slot of root.querySelectorAll(ISLAND_SLOT_TAG)) {
    const id = slot.getAttribute(ISLAND_SLOT_ATTRIBUTE);
    if (id === null || !ISLAND_ID_PATTERN.test(id)) continue;
    const marker = nearestMarker(slot);
    if (marker !== null) ownedBy(slots, marker).set(id, slot.innerHTML);
  }
  const stash = new Map<IslandElement, Map<string, string>>();
  for (const template of root.querySelectorAll(
    `[${ISLAND_TEMPLATE_ATTRIBUTE}]`,
  )) {
    const id = template.getAttribute(ISLAND_TEMPLATE_ATTRIBUTE);
    if (
      id === null ||
      !ISLAND_ID_PATTERN.test(id) ||
      template.localName !== ISLAND_TEMPLATE_TAG
    ) {
      continue;
    }
    const marker = template.parentElement;
    if (marker === null || marker.localName !== ISLAND_TAG) continue;
    // `textContent` reverses the build's escaping of the stash (#108); `innerHTML`
    // would hand back the escaped string.
    ownedBy(stash, marker).set(id, template.content?.textContent ?? "");
    template.remove();
  }
  const unreadable: UnreadableMarker[] = [];
  let position = 0;
  for (const marker of root.querySelectorAll(ISLAND_TAG)) {
    position += 1;
    const result = read(marker, position);
    if ("failure" in result) {
      unreadable.push(result.failure);
      continue;
    }
    const { island } = result;
    // Looked up outside the callback, which a never-visible island holds for the
    // life of the page, so it does not retain every marker's snapshot.
    const owned = slots.get(marker);
    const stashed = stash.get(marker);
    (options.schedule ?? schedule)(marker, island.mode, () => {
      void mount(marker, island, options, owned, stashed);
    });
  }
  if (unreadable.length > 0) throw markerFailure(unreadable);
}

function ownedBy<Entry>(
  by: Map<IslandElement, Map<string, Entry>>,
  key: IslandElement,
): Map<string, Entry> {
  let owned = by.get(key);
  if (owned === undefined) {
    owned = new Map();
    by.set(key, owned);
  }
  return owned;
}

// Here rather than in `slot.ts`: importing from that on-demand module would put
// it in every page's bundle.
function nearestMarker(slot: IslandElement): IslandElement | null {
  for (
    let node = slot.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    if (node.localName === ISLAND_TAG) return node;
  }
  return null;
}

interface Island {
  name: string;
  prefix: string;
  mode: string;
  props: Record<string, unknown>;
}

interface UnreadableMarker {
  label: string;
  reason: string;
  consequence: string;
  cause?: unknown;
}

type MarkerRead = { island: Island } | { failure: UnreadableMarker };

const MARKER_FIX = `a marker is written by the build, so remove the hand-written <${ISLAND_TAG}> from the content`;

function identify(
  name: string | null,
  prefix: string | null,
  position: number,
): string {
  if (name === null) {
    return prefix === null
      ? `marker #${String(position)}`
      : `marker #${String(position)} (${prefix})`;
  }
  return prefix === null ? `"${name}"` : `"${name}" (${prefix})`;
}

function read(marker: IslandElement, position: number): MarkerRead {
  const name = marker.getAttribute(ISLAND_COMPONENT_ATTRIBUTE);
  const prefix = marker.getAttribute(ISLAND_PREFIX_ATTRIBUTE);
  const mode = marker.getAttribute(ISLAND_MODE_ATTRIBUTE);
  const payload = marker.getAttribute(ISLAND_PROPS_ATTRIBUTE);
  const label = identify(name, prefix, position);

  if (name === null) return missing(label, ISLAND_COMPONENT_ATTRIBUTE);
  if (prefix === null) return missing(label, ISLAND_PREFIX_ATTRIBUTE);
  if (mode === null) return missing(label, ISLAND_MODE_ATTRIBUTE);
  if (payload === null) return missing(label, ISLAND_PROPS_ATTRIBUTE);

  let props: Record<string, unknown>;
  try {
    props = JSON.parse(payload) as Record<string, unknown>;
  } catch (cause) {
    return {
      failure: {
        label,
        reason: `its ${ISLAND_PROPS_ATTRIBUTE} is not JSON`,
        consequence: "so there are no props to hydrate it with",
        cause,
      },
    };
  }
  return { island: { name, prefix, mode, props } };
}

function missing(label: string, attribute: string): MarkerRead {
  return {
    failure: {
      label,
      reason: `carries no ${attribute}`,
      consequence: "so there is nothing to hydrate it as",
    },
  };
}

// `RegistryError`, not `ConfigError`: `@pagedeck/core` owns that class and consumes
// this package.
function markerFailure(failures: readonly UnreadableMarker[]): RegistryError {
  const [only] = failures;
  if (failures.length === 1 && only !== undefined) {
    const message = `Island ${only.label}: ${only.reason}, ${only.consequence} — ${MARKER_FIX}`;
    // `{ cause: undefined }` would still install a `cause` property.
    return only.cause === undefined
      ? new RegistryError(message)
      : new RegistryError(message, { cause: only.cause });
  }
  const detail = failures
    .map((failure) => `  ${failure.label}: ${failure.reason}`)
    .join("\n");
  return new RegistryError(
    `Island markers: ${String(failures.length)} on this page cannot be read, so those islands will not hydrate — ${MARKER_FIX}:\n${detail}`,
  );
}

// `slot.js` is imported on demand so a page of leaf islands never downloads it.
async function mount(
  marker: IslandElement,
  island: Island,
  options: HydrateIslandsOptions,
  slots: ReadonlyMap<string, string> | undefined,
  stashed: ReadonlyMap<string, string> | undefined,
): Promise<void> {
  const component = await options.resolve(island.name);
  const container =
    stashed !== undefined || marker.querySelector(ISLAND_SLOT_TAG) !== null;
  const children = container
    ? (await import("./slot.js")).adoptSlots({
        marker,
        component: island.name,
        slots,
        stashed,
        owns: (element) => nearestMarker(element) === marker,
        hydrate: (root) => {
          hydrateIslands({ ...options, root });
        },
      })
    : [];
  // A transition is time-sliced, so a large island yields to input as it
  // hydrates; a default-priority hydration runs in one task (#97).
  startTransition(() => {
    hydrateRoot(
      marker,
      wrapInProviders(
        createElement(component as AnyComponent, island.props, ...children),
        options.providers ?? [],
        options.probe,
      ),
      { identifierPrefix: island.prefix },
    );
  });
}
