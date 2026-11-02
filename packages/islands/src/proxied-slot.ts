// PROTOTYPE (#240): throwaway. The client half of a proxied slot.
import { createElement, Suspense, use } from "react";
import type { ReactElement } from "react";
import { ISLAND_TAG } from "./marker.js";
import type { IslandElement } from "./runtime.js";

type SlotPath = readonly (string | number)[];

interface DomNode {
  readonly nodeType: number;
  readonly data?: string;
  readonly outerHTML?: string;
  readonly textContent: string | null;
  readonly nextSibling: DomNode | null;
}

const never = new Promise<never>(() => {});

function Hole(): null {
  use(never);
  return null;
}

// Built once per path for the island's life: a new props object on a
// dehydrated boundary makes React delete its server HTML.
function standIn(html: string): ReactElement {
  return createElement(
    Suspense,
    {
      fallback: createElement("pagedeck-slot", {
        style: { display: "contents" },
        dangerouslySetInnerHTML: { __html: html },
      }),
    },
    createElement(Hole),
  );
}

function nearestMarker(element: IslandElement): IslandElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node.localName === ISLAND_TAG) return node;
  }
  return null;
}

// The region's HTML after its mark, up to the `<!--/$-->` that closes it.
function regionHtml(mark: IslandElement): string {
  let html = "";
  let depth = 0;
  for (
    let node = (mark as unknown as DomNode).nextSibling;
    node !== null;
    node = node.nextSibling
  ) {
    if (node.nodeType === 8) {
      if (node.data === "/$") {
        if (depth === 0) break;
        depth -= 1;
      } else if (node.data?.startsWith("$")) {
        depth += 1;
      }
      html += `<!--${node.data ?? ""}-->`;
      continue;
    }
    html += node.nodeType === 1 ? (node.outerHTML ?? "") : (node.textContent ?? "");
  }
  return html;
}

function setAt(target: unknown, path: SlotPath, value: unknown): void {
  let at = target as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) {
    at = at[step] as Record<string | number, unknown>;
  }
  at[path[path.length - 1] as string | number] = value;
}

export function proxiedSlotProps(
  marker: IslandElement,
  paths: readonly SlotPath[],
  props: Record<string, unknown>,
  stashed: ReadonlyMap<string, string> | undefined,
): Record<string, unknown> {
  const html = new Map<number, string>();
  for (const mark of marker.querySelectorAll("template[data-pagedeck-region]")) {
    if (nearestMarker(mark) !== marker) continue;
    html.set(Number(mark.getAttribute("data-pagedeck-region")), regionHtml(mark));
  }
  const next = structuredClone(props);
  paths.forEach((path, index) => {
    setAt(next, path, standIn(html.get(index) ?? stashed?.get(String(index)) ?? ""));
  });
  return next;
}
