import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils";
import type { ESTree } from "rolldown/utils";
import { getComponent } from "@pagedeck/islands";
import type { ComponentRegistry, HydrationMode } from "@pagedeck/islands";
import { clientReference } from "./client-reference.js";
import { ConfigError } from "./exit.js";
import { LANG } from "./react-compiler.js";
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

/**
 * Read from the source, never by loading it, so the hooks are in place before
 * any registered module runs (#174). `wrap` is false only where the
 * declaration shows a value no component can be: a variable initialised with
 * nothing, a literal, a template, an object or an array, an enum, a namespace,
 * or `export * as`. Those are re-exported as live bindings. Every other export
 * is wrapped if it is a function once loaded, and passed through if not.
 */
interface ExportedName {
  key: string;
  wrap: boolean;
}

interface Proxied {
  id: string;
  name: string;
  mode: HydrationMode;
  exports: readonly ExportedName[];
}

interface ModuleShape {
  exports: readonly ExportedName[];
  imports: readonly string[];
}

type Kind = "function" | "value" | "unknown";

export async function installClientReferences(
  input: InstallInput,
): Promise<ClientReferenceInstall> {
  const ids = Object.keys(input.clientComponents).sort();
  if (ids.length === 0) return { close: () => undefined };

  const proxied = new Map<string, Proxied>();
  const importers = new Map<string, string[]>();
  const faults: string[] = [];
  for (const id of ids) {
    const name = input.clientComponents[id] as string;
    const url = pathToFileURL(id).href;
    const shape = readShape(id, faults, new Set());
    proxied.set(url, {
      id,
      name,
      mode: modeFor(input.registry, name),
      exports: shape.exports,
    });
    for (const imported of shape.imports) {
      importers.set(imported, [...(importers.get(imported) ?? []), url]);
    }
  }
  if (faults.length > 0) throw exportFaults(faults);

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
    await verifyProxied(proxied, generated, importers);
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

function readShape(
  path: string,
  faults: string[],
  reading: ReadonlySet<string>,
): ModuleShape {
  const source = readFileSync(path, "utf8");
  const lang = LANG[extname(path)];
  const parsed = parseSync(
    path,
    source,
    lang === undefined ? { sourceType: "module" } : { lang, sourceType: "module" },
  );
  const lineOf = (offset: number): number =>
    source.slice(0, offset).split("\n").length;
  const [error] = parsed.errors;
  if (error !== undefined) {
    const at = error.labels[0]?.start;
    faults.push(
      `module "${path}"${at === undefined ? "" : ` line ${String(lineOf(at))}`}: does not parse (${error.message}), so its exports cannot be read — fix the syntax at the line named`,
    );
    return { exports: [], imports: [] };
  }

  const body = parsed.program.body;
  const kinds = bindingKinds(body);
  const url = pathToFileURL(path);
  const own = new Map<string, boolean>();
  const starred: ExportedName[] = [];
  const imports: string[] = [];
  const reach = (specifier: string): string | undefined => {
    if (!/^\.\.?\//.test(specifier)) return undefined;
    const target = new URL(specifier, url).href;
    imports.push(target);
    return target;
  };

  for (const statement of body) {
    switch (statement.type) {
      case "ImportDeclaration":
        if (statement.importKind !== "type") reach(statement.source.value);
        break;
      case "ExportNamedDeclaration": {
        if (statement.exportKind === "type") break;
        if (statement.source !== null) reach(statement.source.value);
        if (statement.declaration !== null) {
          for (const [name, kind] of declared(statement.declaration, kinds)) {
            own.set(name, kind !== "value");
          }
        }
        for (const specifier of statement.specifiers) {
          if (specifier.exportKind === "type") continue;
          const kind =
            statement.source === null
              ? (kinds.get(nameOf(specifier.local)) ?? "unknown")
              : "unknown";
          own.set(nameOf(specifier.exported), kind !== "value");
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration;
        if (declaration.type === "TSInterfaceDeclaration") break;
        const kind =
          declaration.type === "FunctionDeclaration" ||
          declaration.type === "ClassDeclaration"
            ? "function"
            : expressionKind(declaration, kinds);
        own.set("default", kind !== "value");
        break;
      }
      case "ExportAllDeclaration": {
        if (statement.exportKind === "type") break;
        const specifier = statement.source.value;
        const target = reach(specifier);
        if (statement.exported !== null) {
          own.set(nameOf(statement.exported), false);
          break;
        }
        const file = target === undefined ? undefined : fileURLToPath(target);
        if (file === undefined || !existsSync(file)) {
          faults.push(
            `module "${path}" line ${String(lineOf(statement.start))}: export * from "${specifier}" reaches no file by a relative path, and the build reads the exports of a "use client" module without running it — re-export each name instead, as export { Name } from "${specifier}"`,
          );
          break;
        }
        if (reading.has(file)) break;
        const inner = readShape(file, faults, new Set([...reading, path]));
        starred.push(...inner.exports.filter(({ key }) => key !== "default"));
        break;
      }
      default:
        break;
    }
  }

  for (const { key, wrap } of starred) {
    if (!own.has(key)) own.set(key, wrap);
  }
  return {
    exports: [...own].map(([key, wrap]) => ({ key, wrap })),
    imports,
  };
}

function nameOf(node: ESTree.ModuleExportName): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

function bindingKinds(body: readonly ESTree.Statement[]): Map<string, Kind> {
  const kinds = new Map<string, Kind>();
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement.type === "ExportDefaultDeclaration" &&
            (statement.declaration.type === "FunctionDeclaration" ||
              statement.declaration.type === "ClassDeclaration")
          ? statement.declaration
          : statement;
    if (declaration === null) continue;
    for (const [name, kind] of declared(declaration, kinds)) {
      kinds.set(name, kind);
    }
  }
  return kinds;
}

function declared(
  node: ESTree.Statement | ESTree.Declaration,
  kinds: ReadonlyMap<string, Kind>,
): [string, Kind][] {
  if ("declare" in node && node.declare === true) return [];
  switch (node.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return node.id === null ? [] : [[node.id.name, "function"]];
    case "VariableDeclaration":
      return node.declarations.flatMap(({ id, init }): [string, Kind][] =>
        id.type === "Identifier"
          ? [[id.name, init === null ? "value" : expressionKind(init, kinds)]]
          : [],
      );
    case "TSEnumDeclaration":
      return [[node.id.name, "value"]];
    case "TSModuleDeclaration":
      return node.id.type === "Identifier" ? [[node.id.name, "value"]] : [];
    default:
      return [];
  }
}

function expressionKind(
  node: ESTree.Expression,
  kinds: ReadonlyMap<string, Kind>,
): Kind {
  switch (node.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
      return expressionKind(node.expression, kinds);
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "ClassExpression":
      return "function";
    case "Literal":
    case "TemplateLiteral":
    case "ObjectExpression":
    case "ArrayExpression":
      return "value";
    case "Identifier":
      return kinds.get(node.name) ?? "unknown";
    default:
      return "unknown";
  }
}

function exportFaults(faults: readonly string[]): ConfigError {
  if (faults.length === 1) {
    return new ConfigError(`Island loader: ${faults[0] as string}`);
  }
  return new ConfigError(
    `Island loader: the exports of ${String(faults.length)} "use client" modules cannot be read without running them — fix each one below:\n${faults.map((fault) => `  ${fault}`).join("\n")}`,
  );
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
    const value = `fwOriginal[${JSON.stringify(entry.key)}]`;
    lines.push(
      `const ${local} = typeof ${value} === "function" ? fwFactory(${value}, ${options}) : ${value};`,
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
  importers: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  const missed = new Set<string>();
  for (const [url, module] of proxied) {
    const namespace = (await import(/* @vite-ignore */ url)) as Record<
      string,
      unknown
    >;
    if (generated.has(url) || isProxied(module, namespace)) continue;
    missed.add(url);
  }
  if (missed.size === 0) return;

  const roots: string[] = [];
  const imported: string[] = [];
  for (const url of missed) {
    const module = proxied.get(url) as Proxied;
    const line = `  "${module.name}" — "${module.id}"`;
    const by = (importers.get(url) ?? [])
      .filter((importer) => missed.has(importer))
      .map((importer) => `"${(proxied.get(importer) as Proxied).name}"`)
      .sort();
    if (by.length === 0) roots.push(line);
    else imported.push(`${line}, imported by ${by.join(" and ")}`);
  }

  const paragraphs: string[] = [];
  if (roots.length > 0) {
    paragraphs.push(
      `Island loader: ${String(roots.length)} ${
        roots.length === 1
          ? 'module carrying "use client" was already loaded before the build could stand in for it, so nothing another component renders it from would island'
          : 'modules carrying "use client" were already loaded before the build could stand in for them, so nothing another component renders them from would island'
      } — import each through its registry thunk only, and drop the top-level import of it from pagedeck.config.ts:\n${roots.sort().join("\n")}`,
    );
  }
  if (imported.length > 0) {
    paragraphs.push(
      `Island loader: ${String(imported.length)} ${
        imported.length === 1
          ? 'module carrying "use client" was already loaded because another such module imports it, so nothing another component renders it from would island'
          : 'modules carrying "use client" were already loaded because another such module imports each, so nothing another component renders them from would island'
      } — fix the module named beside each, and it islands too:\n${imported.sort().join("\n")}`,
    );
  }
  throw new ConfigError(paragraphs.join("\n\n"));
}

function isProxied(
  module: Proxied,
  namespace: Record<string, unknown>,
): boolean {
  return module.exports
    .filter(
      (entry) => entry.wrap && typeof namespace[entry.key] === "function",
    )
    .every(
      (entry) =>
        (namespace[entry.key] as Record<symbol, unknown>)[
          CLIENT_REFERENCE_TARGET
        ] !== undefined,
    );
}
