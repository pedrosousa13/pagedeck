// Never registered with `customElements.define`: hydration would then depend
// on upgrade timing.
export const ISLAND_TAG = "fw-island";

export const ISLAND_PREFIX_ATTRIBUTE = "data-fw-prefix";

export const ISLAND_COMPONENT_ATTRIBUTE = "data-fw-component";

export const ISLAND_MODE_ATTRIBUTE = "data-fw-mode";

// An attribute, not a JSON `<script>`: React escapes attribute values, so a prop
// holding `</script>` cannot end the payload early.
export const ISLAND_PROPS_ATTRIBUTE = "data-fw-props";

export const ISLAND_SLOT_TAG = "fw-slot";

export const ISLAND_SLOT_ATTRIBUTE = "data-fw-slot";

// Checked where the client reads an id, because a page can carry markup no
// build wrote (#114).
export const ISLAND_ID_PATTERN = /^\d+(\.\d+)*$/;

export const ISLAND_TEMPLATE_TAG = "template";

export const ISLAND_TEMPLATE_ATTRIBUTE = "data-fw-template";

// Nothing here reads it. It lives here so `@pagedeck/core`'s browser-bundled
// `tree.tsx` can strip it without importing `script-elements.ts` (#394).
export const ISLAND_FACADE_ATTRIBUTE = "data-fw-facade";
