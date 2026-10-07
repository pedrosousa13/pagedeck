// `Symbol.for`, not a module-level binding, which a second copy of the module
// would have its own of.
export const SHARED_STORE_STAMP = Symbol.for("fw.shared-store");

export interface SharedStoreStamp {
  store: object;
  provider: unknown;
  hydrated: Set<object>;
  mounted: boolean;
}

type Stamped = { [SHARED_STORE_STAMP]?: SharedStoreStamp };

export function readSharedStoreStamp(): SharedStoreStamp | undefined {
  return (globalThis as Stamped)[SHARED_STORE_STAMP];
}

export function writeSharedStoreStamp(stamp: SharedStoreStamp): void {
  (globalThis as Stamped)[SHARED_STORE_STAMP] = stamp;
}
