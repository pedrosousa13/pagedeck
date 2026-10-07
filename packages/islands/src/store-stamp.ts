// Imports no Jotai, so a site with a provider stack and no store never loads it
// (#252).
import { reportBrowserFault } from "./browser-report.js";
import { readSharedStoreStamp } from "./store-realm.js";

export function markRootsMounting(): void {
  const stamp = readSharedStoreStamp();
  if (stamp !== undefined) stamp.mounted = true;
}

// Not `ConfigError`, which lives in `@pagedeck/core`, a consumer of this package.
export class StoreError extends Error {
  override name = "StoreError";
}

// `production` is passed in, never read from `NODE_ENV`, which would make a
// build's verdict depend on the shell it ran in.
export function checkSharedStore(
  providers: unknown,
  production: boolean,
): void {
  const stamp = readSharedStoreStamp();
  if (stamp === undefined || !Array.isArray(providers)) return;

  const foreign: string[] = [];
  (providers as readonly unknown[]).forEach((provider, at) => {
    const one = provider as { component?: unknown; props?: unknown } | null;
    if (one === null || one.component !== stamp.provider) return;
    const props = one.props;
    if (typeof props !== "object" || props === null) return;
    const delivered = (props as Record<string, unknown>)["store"];
    if (delivered === undefined || delivered === stamp.store) return;
    foreign.push(`stack[${String(at)}].props.store`);
  });
  if (foreign.length === 0) return;

  // The position, never the value (`docs/error-messages.md` rule 6).
  const message = [
    `Shared store: ${foreign.length === 1 ? "1 provider delivers" : `${String(foreign.length)} providers deliver`} a store this framework did not mint, so two island roots resolve the same atoms on two stores and neither sees the other's writes — pass the one instance "@pagedeck/islands/store" exports, and call createStore() nowhere in site code; islands are separate React roots, so one store object reached through one module is the only thing that carries state between them, and a build, a dev server and a preview app refuse this where a shipped page only reports it, because the build's chunk-graph assertion is the gate and a canary must not take a visitor's page away:`,
    ...foreign.map((one) => `  ${one}`),
  ].join("\n");

  if (production) {
    reportBrowserFault(message);
    return;
  }
  throw new StoreError(message);
}
