import { createElement, memo, useEffect, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import {
  ISLAND_ID_PATTERN,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
} from "./marker.js";
import { RegistryError } from "./registry.js";
import type { IslandElement } from "./runtime.js";

export interface SlotContentProps {
  slot: string;
  // Trusted and never sanitised: it carries the build's own nested island
  // markers, which the content strip would remove (#108, #109).
  html: string;
  ref?: RefObject<IslandElement | null>;
}

// The always-equal comparator is the mechanism: a re-render would replace DOM
// that nested islands' roots own (ADR 0005).
export const SlotContent = memo(function SlotContent({
  slot,
  html,
  ref,
}: SlotContentProps): ReactElement {
  return createElement(ISLAND_SLOT_TAG, {
    [ISLAND_SLOT_ATTRIBUTE]: slot,
    role: "presentation",
    style: { display: "contents" },
    dangerouslySetInnerHTML: { __html: html },
    ref,
  });
}, () => true);

interface Adoption {
  component: string;
  hydrate: (root: IslandElement) => void;
  slots: ReadonlyMap<string, string> | undefined;
  mounted: Set<string>;
  inPlace: Set<string>;
}

interface AdoptedSlotProps {
  slot: string;
  html: string;
  adopt: Adoption;
}

const ADOPTED_SLOT_PROPS = ["slot", "html", "adopt"];

const OPAQUE =
  "slotted content is one node of already-rendered HTML that hydration adopts in place, so";

const OPAQUE_FIX = `${OPAQUE} there is no element inside it for cloneElement to give props to and it can never re-render; position, wrap, show, hide and reorder it instead`;

// Restated rather than imported: `@pagedeck/core` consumes this package.
const DUPLICATE_FIX = `${OPAQUE} a second copy has no DOM of its own and the client moves the first one rather than repeating it; render each slotted child at most once`;

// Throws `RegistryError` where the build throws `RenderError`, which this
// package cannot import without inverting the dependency.
function AdoptedSlot(props: AdoptedSlotProps): ReactElement {
  const { slot, html, adopt } = props;
  const element = useRef<IslandElement | null>(null);
  const injected = Object.keys(props).filter(
    (name) => !ADOPTED_SLOT_PROPS.includes(name),
  );
  if (injected.length > 0) {
    throw new RegistryError(
      `Component "${adopt.component}": gives slotted child ${slotIndex(slot)} props it cannot receive (${injected.join(", ")}) — ${OPAQUE_FIX}`,
    );
  }
  useEffect(() => {
    if (adopt.mounted.has(slot)) {
      throw new RegistryError(
        `Component "${adopt.component}": mounts slotted child ${slotIndex(slot)} in two places at once — ${DUPLICATE_FIX}`,
      );
    }
    adopt.mounted.add(slot);
    // Hydrated through the ref, not a DOM query: a forged `<fw-slot>` under a
    // nested island could match the query first (#114).
    if (!adopt.inPlace.delete(slot) && element.current !== null) {
      adopt.hydrate(element.current);
    }
    return () => {
      adopt.mounted.delete(slot);
    };
  }, [slot, adopt]);
  // Adopted DOM on the first mount, the pre-stash snapshot on a re-mount, which
  // must bring back a nested container's stashed slots too.
  const source = adopt.inPlace.has(slot)
    ? html
    : (adopt.slots?.get(slot) ?? html);
  return createElement(SlotContent, { slot, html: source, ref: element });
}

function slotIndex(id: string): string {
  return id.slice(id.lastIndexOf(".") + 1);
}

function compareSlotIds(one: string, other: string): number {
  const left = one.split(".");
  const right = other.split(".");
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at++) {
    const difference = Number(left[at]) - Number(right[at]);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export interface AdoptSlotsOptions {
  marker: IslandElement;
  component: string;
  slots: ReadonlyMap<string, string> | undefined;
  // Taken out of the page by `hydrateIslands` before anything mounts: removing it
  // here races a nested container's hydration.
  stashed?: ReadonlyMap<string, string>;
  // Passed in rather than imported, like `owns`, so this on-demand module stays
  // out of the bundle every page loads.
  hydrate: (root: IslandElement) => void;
  owns: (element: IslandElement) => boolean;
}

// Slot ids are not authenticated, by decision: ADR 0006.
export function adoptSlots({
  marker,
  component,
  slots,
  stashed,
  hydrate,
  owns,
}: AdoptSlotsOptions): readonly ReactNode[] {
  const html = new Map<string, string>();
  const inPlace = new Set<string>();
  for (const element of marker.querySelectorAll(ISLAND_SLOT_TAG)) {
    const id = element.getAttribute(ISLAND_SLOT_ATTRIBUTE);
    if (id === null || !ISLAND_ID_PATTERN.test(id) || !owns(element)) continue;
    html.set(id, element.innerHTML);
    inPlace.add(id);
  }
  if (stashed !== undefined) {
    for (const [id, markup] of stashed) html.set(id, markup);
  }

  const adopt: Adoption = {
    component,
    hydrate,
    inPlace,
    slots,
    mounted: new Set(),
  };
  return [...html]
    .sort(([one], [other]) => compareSlotIds(one, other))
    .map(([slot, markup]) =>
      createElement(AdoptedSlot, { key: slot, slot, html: markup, adopt }),
    );
}
