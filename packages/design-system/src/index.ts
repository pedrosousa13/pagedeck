import { catalog, refuseForeignModules } from "./catalog.js";
import { COMPONENT_CLASSES } from "./component-classes.js";
import { STYLING_OPTIONS } from "./styling.js";
import { defineComponents } from "@pagedeck/islands";
import type { Catalog } from "./catalog.js";
import type {
  ComponentDeclaration,
  ComponentDeclarations,
} from "@pagedeck/islands";

export type CatalogName = Extract<keyof typeof catalog, string>;

function declarationsOf(
  rows: Catalog,
): Readonly<Record<string, ComponentDeclaration>> {
  const declarations: Record<string, ComponentDeclaration> = {};
  for (const [name, entry] of Object.entries(rows)) {
    declarations[name] =
      entry.hydrate === undefined
        ? entry.module
        : { path: entry.module, hydrate: entry.hydrate };
  }
  return declarations;
}

refuseForeignModules(catalog);

export const components: ComponentDeclarations<CatalogName> = defineComponents(
  declarationsOf(catalog),
);

export const safelist: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    Object.entries(STYLING_OPTIONS).map(([field, option]) => [
      field,
      [
        ...new Set(
          Object.values(option.values).flatMap((all) => all.split(" ")),
        ),
      ].sort(),
    ]),
  ),
  // Copied, so a consumer holding one of these arrays cannot reach the table.
  ...Object.fromEntries(
    Object.entries(COMPONENT_CLASSES).map(([name, classes]) => [
      name,
      [...new Set(classes)].sort(),
    ]),
  ),
};
