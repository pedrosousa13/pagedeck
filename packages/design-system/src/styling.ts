// The only place a CMS value becomes a class (spec §9), and the safelist is
// derived from it, so no class comes from content.

export interface StylingField {
  // Named rather than taken from key order, so reordering the table cannot
  // restyle every unset field.
  fallback: string;
  values: Readonly<Record<string, string>>;
}

export const STYLING_OPTIONS: Readonly<Record<string, StylingField>> = {
  "hero.theme": {
    fallback: "light",
    values: {
      light: "bg-(--fw-bg-raised) text-(--fw-fg)",
      dark: "bg-(--fw-fg) text-(--fw-bg)",
    },
  },
  "button.variant": {
    fallback: "primary",
    values: {
      primary: "bg-(--fw-bg-accent) text-(--fw-fg-on-accent)",
      secondary: "bg-(--fw-bg-subtle) text-(--fw-fg)",
      ghost: "bg-transparent text-inherit underline",
    },
  },
  "feature_grid.columns": {
    fallback: "three",
    values: {
      two: "grid-cols-1 sm:grid-cols-2",
      three: "grid-cols-1 sm:grid-cols-3",
      four: "grid-cols-2 sm:grid-cols-4",
    },
  },
};

function offered(field: StylingField): string {
  return Object.keys(field.values)
    .map((value) => `"${value}"`)
    .join(", ");
}

export function classesFor(field: string, value: string | undefined): string {
  // `Object.hasOwn`: the value comes from a CMS field, and a bare index answers
  // `"constructor"` off the prototype (#145).
  const options = Object.hasOwn(STYLING_OPTIONS, field)
    ? STYLING_OPTIONS[field]
    : undefined;
  if (options === undefined) {
    throw new Error(
      `Styling option "${field}": no component declares it — add it to STYLING_OPTIONS, or drop the reference from the component`,
    );
  }
  const chosen = value ?? options.fallback;
  const classes = Object.hasOwn(options.values, chosen)
    ? options.values[chosen]
    : undefined;
  if (classes === undefined) {
    throw new Error(
      `Styling option "${field}": "${chosen}" is not one of the values it offers — set the field to one of ${offered(options)}, or leave it unset for "${options.fallback}"`,
    );
  }
  return classes;
}
