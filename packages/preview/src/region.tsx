// The adapter marks and this only hosts: a region is a node an adapter sent, so a bridge that
// sends none renders none (#54). `display: contents` still shows to structural selectors.
import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import type { ComponentRegistry } from "@pagedeck/islands";
import { PreviewDraftError } from "./draft.js";

// In the `fw-` namespace, so a site's registry cannot redefine it.
export const PREVIEW_REGION = "fw-preview-region";

export const PREVIEW_REGION_TAG = "fw-region";

// `data-*` only: a custom element carrying `onclick` would run it, and a draft is CMS content.
const REGION_ATTRIBUTE = /^data-[a-z][a-z0-9-]*$/;

export interface PreviewRegionProps {
  /** The `data-*` attribute an editor queries for. */
  attribute?: unknown;
  /** What that attribute says — the adapter's handle on the marked node. */
  value?: unknown;
  children?: ReactNode;
}

// A `PreviewDraftError`: the payload is wrong. The value is never quoted (rule 6).
function PreviewRegion(props: PreviewRegionProps): ReactElement {
  const faults: string[] = [];
  if (typeof props.attribute !== "string" || !REGION_ATTRIBUTE.test(props.attribute)) {
    faults.push(
      `attribute ${JSON.stringify(props.attribute)} is not a data attribute name`,
    );
  }
  if (typeof props.value !== "string") {
    faults.push("value is not the handle the attribute carries");
  }
  if (faults.length > 0) {
    throw new PreviewDraftError(
      `Preview region: ${faults.join(", and ")} — a region marks one node for an editor with one data-* attribute, so send { attribute: "data-<name>", value: "<handle>" } or send the node unwrapped`,
      faults,
    );
  }
  return createElement(
    PREVIEW_REGION_TAG,
    {
      [props.attribute as string]: props.value,
      role: "presentation",
      style: { display: "contents" },
    },
    props.children,
  );
}

export const PREVIEW_REGIONS: ComponentRegistry = {
  [PREVIEW_REGION]: { import: () => Promise.resolve({ default: PreviewRegion }) },
};
