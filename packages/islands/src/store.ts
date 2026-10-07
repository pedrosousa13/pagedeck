import { Provider, createStore } from "jotai";
import { useAtomCallback } from "jotai/utils";
import type { Atom, Getter, Setter, WritableAtom } from "jotai";
import { reportBrowserFault } from "./browser-report.js";
import {
  readSharedStoreStamp,
  writeSharedStoreStamp,
} from "./store-realm.js";
import type { SharedStoreStamp } from "./store-realm.js";

export { StoreError, checkSharedStore } from "./store-stamp.js";

// Re-exported so a site never resolves a second copy of Jotai, whose atoms
// nothing else on the page could address (ADR 0007).
export { Provider, atom, useAtom, useAtomValue, useSetAtom } from "jotai";

export type SharedStore = ReturnType<typeof createStore>;

type AnyWritableAtom = WritableAtom<unknown, [unknown], unknown>;

// Adopts an earlier copy's store rather than counting evaluations: Vite's dev
// server legitimately evaluates a linked workspace package twice.
function stamp(): SharedStoreStamp {
  const existing = readSharedStoreStamp();
  if (
    existing !== undefined &&
    typeof (existing.store as SharedStore).get === "function"
  ) {
    return existing;
  }
  const fresh: SharedStoreStamp = {
    store: createStore(),
    // Recorded here so `checkSharedStore` can recognise it without importing Jotai.
    provider: Provider,
    hydrated: new Set(),
    mounted: false,
  };
  writeSharedStoreStamp(fresh);
  return fresh;
}

export const store: SharedStore = stamp().store as SharedStore;

function atomName(one: Atom<unknown>, at: number): string {
  const label = one.debugLabel;
  return label === undefined
    ? `atom[${String(at)}] — no debugLabel`
    : `atom[${String(at)}] "${label}"`;
}

function countedAtoms(count: number): string {
  return count === 1 ? "1 atom" : `${String(count)} atoms`;
}

export function hydrateStore(
  values: Iterable<readonly [Atom<unknown>, unknown]>,
): void {
  const current = stamp();
  const shared = current.store as SharedStore;
  const hydrated = current.hydrated;
  const already: string[] = [];
  // Reported, and the values still written: roots yet to mount want them.
  if (current.mounted) reportLate();
  let at = 0;
  for (const [one, value] of values) {
    if (hydrated.has(one)) already.push(atomName(one, at));
    else {
      hydrated.add(one);
      shared.set(one as AnyWritableAtom, value);
    }
    at += 1;
  }
  if (already.length === 0) return;
  reportBrowserFault(
    [
      `Shared store: ${countedAtoms(already.length)} ${already.length === 1 ? "is" : "are"} hydrated a second time, and an atom hydrates once per store, so the value this call brought was dropped and the first one kept — hydrate the shared store once, from the page and before any root mounts, and give an island its own atom rather than a second value for a shared one; island hydration order is not controlled under the "visible" and "idle" strategies, so which value survives is not the site's to choose. This is reported and not refused because the page renders and only its state is wrong, and refusing here would cost every island that has not hydrated yet:`,
      ...already.map((line) => `  ${line}`),
    ].join("\n"),
  );
}

function reportLate(): void {
  reportBrowserFault(
    `Shared store: hydrateStore was called after island roots began mounting, so every root that had already rendered did it with the value the store held before this call — a visible flash where the value is rendered, and a wrong answer for anything that read it in an effect or an event before the write landed — call hydrateStore from the page, above the module that hydrates the islands, so the store is complete before the first root mounts. This is reported and not refused because the page renders and only its state is wrong, and refusing here would take away the roots that mounted correctly.`,
  );
}

// Jotai's escape hatches silently read the default store unless given one,
// and nothing on the page uses that store.
export function useStoreCallback<Result, Args extends unknown[]>(
  callback: (get: Getter, set: Setter, ...args: Args) => Result,
): (...args: Args) => Result {
  return useAtomCallback(callback, { store });
}
