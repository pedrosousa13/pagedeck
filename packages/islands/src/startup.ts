import { ISLAND_MODE_ATTRIBUTE, ISLAND_SLOT_TAG, ISLAND_TAG } from "./marker.js";
import type { IslandElement, IslandRoot } from "./runtime.js";

interface Intersection {
  isIntersecting: boolean;
}

// Not the `DOM` lib, which would type `document` in node-only packages. Read off
// `globalThis` because a bare `requestIdleCallback` throws where it is missing.
interface Browser {
  document: IslandRoot;
  IntersectionObserver: new (
    callback: (entries: readonly Intersection[]) => void,
  ) => { observe(target: IslandElement): void; disconnect(): void };
  requestIdleCallback?: (callback: () => void) => void;
  reportError(error: unknown): void;
}
const browser = globalThis as unknown as Browser;

export type Schedule = (
  marker: IslandElement,
  mode: string,
  hydrate: () => void,
) => void;

// Safari has never shipped `requestIdleCallback`, so every iPhone takes this.
const IDLE_FALLBACK_MS = 200;

export const schedule: Schedule = (marker, mode, hydrate) => {
  if (mode === "load") hydrate();
  else if (mode === "idle") whenIdle(hydrate);
  else if (mode === "interaction") whenInteracted(marker, hydrate);
  else whenVisible(marker, hydrate);
};

function whenIdle(hydrate: () => void): void {
  const requestIdle = browser.requestIdleCallback;
  if (requestIdle === undefined) setTimeout(hydrate, IDLE_FALLBACK_MS);
  else requestIdle(hydrate);
}

// Observes the marker's element children, not the marker: under
// `display: contents` it has no box and would never intersect (prototype #68).
function whenVisible(marker: IslandElement, hydrate: () => void): void {
  const targets = observableTargets(marker);
  if (targets.length === 0) {
    whenIdle(hydrate);
    return;
  }
  let hydrated = false;
  const observer = new browser.IntersectionObserver((entries) => {
    if (hydrated || !entries.some((entry) => entry.isIntersecting)) return;
    hydrated = true;
    // Before hydrating, which replaces the observed children: watching detached
    // nodes would keep the island's old subtree alive.
    observer.disconnect();
    hydrate();
  });
  for (const target of targets) {
    // An `observe` can deliver synchronously and hydrate, and re-arming then would
    // leave an observer nothing disconnects.
    if (hydrated) break;
    observer.observe(target);
  }
}

function observableTargets(
  element: IslandElement,
  into: IslandElement[] = [],
): IslandElement[] {
  for (const child of Array.from(element.children)) {
    if (child.localName === ISLAND_SLOT_TAG || child.localName === ISLAND_TAG) {
      observableTargets(child, into);
    } else into.push(child);
  }
  return into;
}

const INTERACTIONS = ["focusin", "pointerdown"];

// Listens on the marker, so only events from inside the island reach it. The
// event that fires it is not replayed: replaying a press could act twice.
function whenInteracted(marker: IslandElement, hydrate: () => void): void {
  if (observableTargets(marker).length === 0) {
    whenIdle(hydrate);
    return;
  }
  const fire = (): void => {
    for (const type of INTERACTIONS) marker.removeEventListener(type, fire);
    hydrate();
  };
  for (const type of INTERACTIONS) marker.addEventListener(type, fire);
}

/**
 * Arms each marker's trigger, and calls `start` once, on the first to fire.
 * `start` loads the runtime and hands it the `Schedule` it is called with,
 * which holds each marker's hydrate until that marker's own trigger fires.
 */
export function hydrateOnTrigger(
  start: (schedule: Schedule) => Promise<void>,
): void {
  const armed = new Map<IslandElement, (() => void) | undefined>();
  // A marker read here was armed already; any other came from a container's
  // re-mounted slot after the read, and is scheduled as usual.
  const held: Schedule = (marker, mode, hydrate) => {
    if (armed.has(marker)) armed.set(marker, hydrate);
    else schedule(marker, mode, hydrate);
  };
  let started: Promise<void> | undefined;
  for (const marker of browser.document.querySelectorAll(ISLAND_TAG)) {
    armed.set(marker, undefined);
    schedule(marker, marker.getAttribute(ISLAND_MODE_ATTRIBUTE) ?? "", () => {
      // Caught so a marker the runtime cannot read is reported once, and the
      // islands it could read still hydrate.
      started ??= start(held).catch((error: unknown) => {
        browser.reportError(error);
      });
      void started.then(() => armed.get(marker)?.());
    });
  }
}
