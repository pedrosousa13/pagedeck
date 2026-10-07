// Preview must never be more capable than production (spec §14, ADR-0005). Slotted children
// render beside their container and are portalled in, so its context and re-renders miss them.
import {
  createContext,
  createElement,
  Fragment,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ISLAND_SLOT_TAG } from "@pagedeck/islands";
import type { IslandNodeElement } from "@pagedeck/core/tree";

// Its own class, not `RegistryError`: a browser app has no exit code to carry.
export class PreviewParityError extends Error {
  override readonly name = "PreviewParityError";
}

// Said again rather than imported: `OPAQUE_FIX` is private to `@pagedeck/islands`' `slot.ts`.
const OPAQUE =
  "slotted content is one node of already-rendered HTML that hydration adopts in place, so";

const OPAQUE_FIX = `${OPAQUE} there is no element inside it for cloneElement to give props to and it can never re-render; position, wrap, show, hide and reorder it instead`;

const DUPLICATE_FIX = `${OPAQUE} a second copy has no DOM of its own and the client moves the first one rather than repeating it; render each slotted child at most once`;

interface PreviewSlotProps {
  /** The child's position in the entry tree, dotted — production's slot id. */
  slot: string;
}

const PREVIEW_SLOT_PROPS = ["slot"];

// Declared structurally, not via the `DOM` lib.
type SlotHost = object;

// Context, not a prop: every `PreviewSlot` prop is one a container could read off a child.
const SlottedChildren = createContext<SlottedInto | undefined>(undefined);

interface SlottedInto {
  component: string;
  children: ReadonlyMap<string, ReactElement>;
  hosts: Map<string, SlotHost>;
  mounted: Set<string>;
  attached: () => void;
}

function slotIndex(slot: string): string {
  const segments = slot.split(".");
  return segments[segments.length - 1] ?? slot;
}

function slotRefusal(
  props: PreviewSlotProps,
  into: SlottedInto | undefined,
): PreviewParityError | undefined {
  if (into === undefined) {
    // Unreachable through `previewIsland`; reachable by a component rendering `PreviewSlot` itself.
    return new PreviewParityError(
      `Preview slot ${slotIndex(props.slot)}: rendered outside the container the entry nested it in — a slotted child is placed by its own container, so render the children the entry gave you and nothing else`,
    );
  }
  // `AdoptedSlot` counts injected props the same way; `cloneElement` shows up as extras.
  const injected = Object.keys(props).filter(
    (name) => !PREVIEW_SLOT_PROPS.includes(name),
  );
  if (injected.length > 0) {
    return new PreviewParityError(
      `Component "${into.component}": gives slotted child ${slotIndex(props.slot)} props it cannot receive (${injected.join(", ")}) — ${OPAQUE_FIX}`,
    );
  }
  if (!into.children.has(props.slot)) {
    return new PreviewParityError(
      `Component "${into.component}": renders a slotted child ${slotIndex(props.slot)} the entry does not have — render the children the entry gave you and nothing else`,
    );
  }
  return undefined;
}

// No slot id: nothing hydrates here, and an id in the DOM is a name content could forge (#109).
function PreviewSlot(props: PreviewSlotProps): ReactElement {
  const into = useContext(SlottedChildren);
  const host = useRef<SlotHost | null>(null);
  const { slot } = props;
  // Computed before the hooks and thrown after, so React does not report a hook-count fault.
  const refusal = slotRefusal(props, into);
  useLayoutEffect(() => {
    if (refusal !== undefined || into === undefined || host.current === null) {
      return undefined;
    }
    if (into.mounted.has(slot)) {
      throw new PreviewParityError(
        `Component "${into.component}": mounts slotted child ${slotIndex(slot)} in two places at once — ${DUPLICATE_FIX}`,
      );
    }
    into.mounted.add(slot);
    into.hosts.set(slot, host.current);
    into.attached();
    return () => {
      into.mounted.delete(slot);
      into.hosts.delete(slot);
      into.attached();
    };
  }, [into, slot, refusal]);
  if (refusal !== undefined) throw refusal;

  return createElement(ISLAND_SLOT_TAG, {
    ref: host,
    role: "presentation",
    style: { display: "contents" },
  });
}

function SlotPortals({ into }: { into: SlottedInto }): ReactNode {
  const portals: ReactNode[] = [];
  for (const [slot, child] of into.children) {
    const host = into.hosts.get(slot);
    // Absent before the host's commit, and for good on a slot the container never placed.
    if (host === undefined) continue;
    portals.push(
      createPortal(child, host as Parameters<typeof createPortal>[1], slot),
    );
  }
  return portals;
}

interface PreviewContainerProps {
  component: string;
  slots: ReadonlyMap<string, ReactElement>;
  container: ReactElement;
}

// A portal needs its host first, so `PreviewSlot`'s layout effect bumps this for a second pass.
function PreviewContainer(props: PreviewContainerProps): ReactElement {
  const [, attached] = useReducer((count: number) => count + 1, 0);
  const into = useMemo<SlottedInto>(
    () => ({
      component: props.component,
      children: props.slots,
      hosts: new Map(),
      mounted: new Set(),
      attached,
    }),
    [props.component, props.slots],
  );
  return createElement(
    Fragment,
    null,
    createElement(SlottedChildren.Provider, { value: into }, props.container),
    createElement(SlotPortals, { into }),
  );
}

export function previewIsland(island: IslandNodeElement): ReactElement {
  const { node, position, type, props, children } = island;
  if (children.length === 0) return createElement(type, props);

  const slots = new Map<string, ReactElement>();
  const placed = children.map((child, at) => {
    const slot = [...position, at].join(".");
    slots.set(slot, child);
    return createElement(PreviewSlot, { key: String(at), slot });
  });
  return createElement(PreviewContainer, {
    key: props.key as string | undefined,
    component: node.component,
    slots,
    container: createElement(type, props, ...placed),
  });
}
