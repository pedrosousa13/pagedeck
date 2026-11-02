import { createElement, startTransition, useEffect } from "react";
import type { ComponentType, ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_ID_PATTERN,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_REGION_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_PATHS_ATTRIBUTE,
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
  setAttribute(name: string, value: string): void;
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
  resolve: (name: string, exported: string | null) => Promise<ComponentType<never>>;
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
  const regions = new Map<IslandElement, Region[]>();
  for (const mark of root.querySelectorAll(
    `${ISLAND_TEMPLATE_TAG}[${ISLAND_REGION_ATTRIBUTE}]`,
  )) {
    const marker = nearestMarker(mark);
    if (marker === null) continue;
    const region = {
      index: mark.getAttribute(ISLAND_REGION_ATTRIBUTE) ?? "",
      html: regionHtml(mark),
    };
    const owned = regions.get(marker);
    if (owned === undefined) regions.set(marker, [region]);
    else owned.push(region);
  }
  const unreadable: UnreadableMarker[] = [];
  let position = 0;
  for (const marker of root.querySelectorAll(ISLAND_TAG)) {
    position += 1;
    const result = read(marker, position, regions.get(marker));
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
  propSlots?: PropSlots;
}

export type PropPath = readonly (string | number)[];

export interface PropSlots {
  paths: readonly PropPath[];
  html: ReadonlyMap<number, string>;
}

interface Region {
  index: string;
  html: string;
}

interface RegionNode {
  readonly nodeType: number;
  readonly data?: string;
  readonly outerHTML?: string;
  readonly textContent: string | null;
  readonly nextSibling: RegionNode | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// From the mark to the `<!--/$-->` that closes its boundary, counting the
// boundaries nested inside it.
function regionHtml(mark: IslandElement): string {
  let html = "";
  let depth = 0;
  for (
    let node = (mark as unknown as RegionNode).nextSibling;
    node !== null;
    node = node.nextSibling
  ) {
    if (node.nodeType === COMMENT_NODE) {
      const data = node.data ?? "";
      if (data === "/$") {
        if (depth === 0) break;
        depth -= 1;
      } else if (data.startsWith("$")) {
        depth += 1;
      }
      html += `<!--${data}-->`;
    } else if (node.nodeType === ELEMENT_NODE) {
      html += node.outerHTML ?? "";
    } else if (node.nodeType === TEXT_NODE) {
      html += escapeText(node.textContent ?? "");
    }
  }
  return html;
}

const REGION_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

const isSegment = (segment: unknown): segment is string | number =>
  typeof segment === "string" ||
  (typeof segment === "number" && Number.isInteger(segment) && segment >= 0);

// Own properties only, down to a `null`: the stand-in is written there, so a
// forged path must not reach a prototype.
function holdsNullAt(props: unknown, path: readonly unknown[]): boolean {
  if (path.length === 0 || !path.every(isSegment)) return false;
  let at = props;
  for (const segment of path) {
    if (typeof at !== "object" || at === null) return false;
    if (Array.isArray(at) !== (typeof segment === "number")) return false;
    if (!Object.hasOwn(at, segment)) return false;
    at = (at as Record<string | number, unknown>)[segment];
  }
  return at === null;
}

function readPropSlots(
  marker: IslandElement,
  props: Record<string, unknown>,
  regions: readonly Region[] | undefined,
): PropSlots | { reason: string; consequence: string; cause?: unknown } {
  const listed = marker.getAttribute(ISLAND_SLOT_PATHS_ATTRIBUTE);
  const consequence = "so its prop slots cannot be placed";
  let paths: unknown;
  try {
    paths = JSON.parse(listed ?? "[]");
  } catch (cause) {
    return {
      reason: `its ${ISLAND_SLOT_PATHS_ATTRIBUTE} is not JSON`,
      consequence,
      cause,
    };
  }
  if (
    !Array.isArray(paths) ||
    !paths.every((path) => Array.isArray(path) && holdsNullAt(props, path))
  ) {
    return {
      reason: `its ${ISLAND_SLOT_PATHS_ATTRIBUTE} is not a list of paths to null props`,
      consequence,
    };
  }
  const html = new Map<number, string>();
  for (const { index, html: markup } of regions ?? []) {
    if (!REGION_INDEX_PATTERN.test(index) || Number(index) >= paths.length) {
      return {
        reason: `holds a region whose ${ISLAND_REGION_ATTRIBUTE} is not an index into its ${ISLAND_SLOT_PATHS_ATTRIBUTE}`,
        consequence,
      };
    }
    if (html.has(Number(index))) {
      return {
        reason: `holds two regions whose ${ISLAND_REGION_ATTRIBUTE} is the same index`,
        consequence,
      };
    }
    html.set(Number(index), markup);
  }
  return { paths: paths as PropPath[], html };
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

function read(
  marker: IslandElement,
  position: number,
  regions: readonly Region[] | undefined,
): MarkerRead {
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
  if (
    regions === undefined &&
    marker.getAttribute(ISLAND_SLOT_PATHS_ATTRIBUTE) === null
  ) {
    return { island: { name, prefix, mode, props } };
  }
  const propSlots = readPropSlots(marker, props, regions);
  if ("reason" in propSlots) return { failure: { label, ...propSlots } };
  return { island: { name, prefix, mode, props, propSlots } };
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

// Outermost, so its effect runs after every effect in the island's tree.
function Hydrated(props: { marker: IslandElement; children?: ReactNode }) {
  // React Compiler's memo cache would add about 308 B raw to every island page.
  "use no memo";
  useEffect(() => {
    props.marker.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, "");
  }, []);
  return props.children;
}

// `slot.js` is imported on demand so a page of leaf islands never downloads it.
async function mount(
  marker: IslandElement,
  island: Island,
  options: HydrateIslandsOptions,
  slots: ReadonlyMap<string, string> | undefined,
  stashed: ReadonlyMap<string, string> | undefined,
): Promise<void> {
  const component = await options.resolve(
    island.name,
    marker.getAttribute(ISLAND_EXPORT_ATTRIBUTE),
  );
  const props =
    island.propSlots === undefined
      ? island.props
      : (await import("./slot.js")).propSlotProps(island.props, island.propSlots);
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
      createElement(
        Hydrated,
        { marker },
        wrapInProviders(
          createElement(component as AnyComponent, props, ...children),
          options.providers ?? [],
          options.probe,
        ),
      ),
      { identifierPrefix: island.prefix },
    );
  });
}
