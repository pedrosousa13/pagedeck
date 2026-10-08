export const ISLANDS_VERSION = "0.2.0";

export {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_FACADE_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
  ISLAND_TEMPLATE_TAG,
} from "./marker.js";
export { SlotContent } from "./slot.js";
export type { SlotContentProps } from "./slot.js";
export {
  componentFaults,
  defineComponents,
  entryId,
  getComponent,
  hydrationContradiction,
  HYDRATION_CONTRADICTION_FIX,
  installRegistryWarnings,
  mergeComponents,
  RegistryError,
  resolveComponent,
  resolveHydrationMode,
} from "./registry.js";
export { wrapInProviders } from "./providers.js";
export { checkSharedStore, StoreError } from "./store-stamp.js";
export type { RootProvider } from "./providers.js";
export type {
  ComponentDeclaration,
  ComponentDeclarations,
  ComponentDefinition,
  ComponentPath,
  ComponentRegistry,
  HydrationMode,
  HydrationSource,
  ModuleFacts,
  PageContext,
  ResolvedHydration,
} from "./registry.js";
