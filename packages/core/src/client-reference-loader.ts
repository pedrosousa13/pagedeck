import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { getComponent } from "@pagedeck/islands";
import type { ComponentRegistry, HydrationMode } from "@pagedeck/islands";
import { clientReference } from "./client-reference.js";
import { ConfigError } from "./exit.js";
import { CLIENT_REFERENCE_TARGET } from "./tree.js";

export interface ClientReferenceInstall {
  close(): void;
}

export interface InstallInput {
  clientComponents: Readonly<Record<string, string>>;
  registry: ComponentRegistry;
}

const ORIGINAL_QUERY = "fw-client-original";

/**
 * A registered symbol on `globalThis`, not an import: the generated module is
 * loaded by Node, and this one may be TypeScript under the test runner (#177).
 */
const FACTORY = Symbol.for("@pagedeck/core client reference factory");

interface Proxied {
  id: string;
  name: string;
  mode: HydrationMode;
  exports: readonly { key: string; wrap: boolean }[];
}

export async function installClientReferences(
  input: InstallInput,
): Promise<ClientReferenceInstall> {
  const ids = Object.keys(input.clientComponents).sort();
  if (ids.length === 0) return { close: () => undefined };

  // Read here, not in the hook: `registerHooks` is synchronous, and export
  // names need the module evaluated.
  const proxied = new Map<string, Proxied>();
  for (const id of ids) {
    const name = input.clientComponents[id] as string;
    const mode = modeFor(input.registry, name);
    const url = pathToFileURL(id).href;
    const namespace = (await import(
      /* @vite-ignore */ `${url}?${ORIGINAL_QUERY}`
    )) as Record<string, unknown>;
    proxied.set(url, {
      id,
      name,
      mode,
      exports: Object.keys(namespace).map((key) => ({
        key,
        wrap: typeof namespace[key] === "function",
      })),
    });
  }

  // Saved and restored, not deleted: a nested installation must leave the outer
  // one its factory.
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const previousFactory = slots[FACTORY];
  const hadFactory = FACTORY in slots;
  slots[FACTORY] = clientReference;
  const restoreFactory = (): void => {
    if (hadFactory) slots[FACTORY] = previousFactory;
    else delete slots[FACTORY];
  };

  const generated = new Set<string>();
  const hooks = registerHooks({
    load: (url, context, nextLoad) => {
      const module = proxied.get(url);
      if (module === undefined) return nextLoad(url, context);
      generated.add(url);
      return {
        format: "module",
        shortCircuit: true,
        source: proxyModule(url, module),
      };
    },
  });

  try {
    await verifyProxied(proxied, generated);
  } catch (refusal) {
    hooks.deregister();
    restoreFactory();
    throw refusal;
  }
  return {
    close: () => {
      hooks.deregister();
      restoreFactory();
    },
  };
}

function modeFor(registry: ComponentRegistry, name: string): HydrationMode {
  return getComponent(registry, name)?.hydrate ?? "visible";
}

function proxyModule(url: string, module: Proxied): string {
  const original = `${url}?${ORIGINAL_QUERY}`;
  const options = JSON.stringify({ name: module.name, mode: module.mode });
  const lines = [
    `import * as fwOriginal from ${JSON.stringify(original)};`,
    `const fwFactory = globalThis[Symbol.for(${JSON.stringify(FACTORY.description as string)})];`,
  ];
  for (const [at, entry] of module.exports.entries()) {
    if (!entry.wrap) {
      // Re-exported, not copied off the namespace, so a binding stays live.
      lines.push(
        `export { ${exportName(entry.key)} as ${exportName(entry.key)} } from ${JSON.stringify(original)};`,
      );
      continue;
    }
    const local = `fw${String(at)}`;
    lines.push(
      `const ${local} = fwFactory(fwOriginal[${JSON.stringify(entry.key)}], ${options});`,
      `export { ${local} as ${exportName(entry.key)} };`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function exportName(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

async function verifyProxied(
  proxied: ReadonlyMap<string, Proxied>,
  generated: ReadonlySet<string>,
): Promise<void> {
  const missed: string[] = [];
  for (const [url, module] of proxied) {
    const namespace = (await import(/* @vite-ignore */ url)) as Record<
      string,
      unknown
    >;
    if (generated.has(url) || isProxied(module, namespace)) continue;
    missed.push(`  "${module.name}" — "${module.id}"`);
  }
  if (missed.length === 0) return;
  throw new ConfigError(
    `Island loader: ${String(missed.length)} ${
      missed.length === 1
        ? 'module carrying "use client" was already loaded before the build could stand in for it, so nothing another component renders it from would island'
        : 'modules carrying "use client" were already loaded before the build could stand in for them, so nothing another component renders them from would island'
    } — import each through its registry thunk only, and drop the top-level import of it from pagedeck.config.ts:\n${missed.sort().join("\n")}`,
  );
}

function isProxied(
  module: Proxied,
  namespace: Record<string, unknown>,
): boolean {
  return module.exports
    .filter((entry) => entry.wrap)
    .every(
      (entry) =>
        (namespace[entry.key] as Record<symbol, unknown> | undefined)?.[
          CLIENT_REFERENCE_TARGET
        ] !== undefined,
    );
}
