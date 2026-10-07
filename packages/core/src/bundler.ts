import { build } from "vite";
import type { InlineConfig, Plugin, PluginOption } from "vite";

export interface HookFault {
  plugin: string;
  hook: string;
  error: Error;
}

const NOT_HOOKS = new Set([
  "name",
  "enforce",
  "apply",
  "applyToEnvironment",
]);

function handlerOf(value: unknown): ((...args: never[]) => unknown) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const handler = (value as { handler?: unknown }).handler;
  return typeof handler === "function"
    ? (handler as (...args: never[]) => unknown)
    : undefined;
}

function guardHook(
  plugin: string,
  hook: string,
  fn: (...args: never[]) => unknown,
  record: (fault: HookFault) => void,
): (...args: never[]) => unknown {
  return function guarded(this: unknown, ...args: never[]): unknown {
    const fault = (error: unknown): undefined => {
      record({
        plugin,
        hook,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return undefined;
    };
    try {
      const result = Reflect.apply(fn, this, args) as unknown;
      if (
        typeof (result as { then?: unknown } | null | undefined)?.then ===
        "function"
      ) {
        return (result as Promise<unknown>).then(undefined, fault);
      }
      return result;
    } catch (error) {
      return fault(error);
    }
  };
}

function guardPlugin(
  plugin: Plugin,
  record: (fault: HookFault) => void,
): Plugin {
  const guarded = { ...plugin } as Plugin & Record<string, unknown>;
  for (const [key, value] of Object.entries(plugin)) {
    if (NOT_HOOKS.has(key)) continue;
    if (typeof value === "function") {
      guarded[key] = guardHook(
        plugin.name,
        key,
        value as (...args: never[]) => unknown,
        record,
      );
      continue;
    }
    const handler = handlerOf(value);
    if (handler !== undefined) {
      guarded[key] = {
        ...(value as object),
        handler: guardHook(plugin.name, key, handler, record),
      };
    }
  }
  return guarded;
}

export interface BundleOptions {
  plugins: readonly Plugin[];
  /**
   * Not guarded on purpose: a site's or test's plugin errors are not ours to
   * reclassify (error rule 7).
   */
  sitePlugins?: readonly PluginOption[];
  onFault?: (fault: HookFault) => void;
  config: Omit<InlineConfig, "plugins">;
}

export async function runBundle(
  options: BundleOptions,
): Promise<Awaited<ReturnType<typeof build>>> {
  let first: HookFault | undefined;
  const record = (fault: HookFault): void => {
    first ??= fault;
    options.onFault?.(fault);
  };

  let failure: unknown;
  let result: Awaited<ReturnType<typeof build>> | undefined;
  try {
    result = await build({
      ...options.config,
      plugins: [
        ...options.plugins.map((plugin) => guardPlugin(plugin, record)),
        ...(options.sitePlugins ?? []),
      ],
    });
  } catch (error) {
    failure = error;
  }

  // Thrown unwrapped to keep its class and cause; the build's own rejection is
  // a downstream symptom and is dropped rather than attached (#94).
  if (first !== undefined) throw first.error;
  if (failure !== undefined) throw failure;
  if (result === undefined) {
    throw new Error(
      `Bundler: build() neither returned a result nor failed — this is a framework fault, not a site one; report it against @pagedeck/core`,
    );
  }
  return result;
}
