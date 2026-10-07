import { classesFor } from "../styling.js";

export default function Button({
  label,
  href,
  variant,
}: {
  label: string;
  // A path, never the CMS `link` field: only `canonicalizePath` spells a path
  // (ADR-0003).
  href: string;
  variant?: string;
}) {
  // Props come from CMS content whatever the type says, and an `<a>` with no
  // target looks exactly like a working call to action.
  if (typeof href !== "string" || href === "") {
    throw new Error(
      `Button "${label}": has no href — resolve the entry's link field to a path and pass it as "href", so the anchor points somewhere`,
    );
  }
  return (
    <a
      className={`button ${classesFor("button.variant", variant)}`}
      href={href}
    >
      {label}
    </a>
  );
}
