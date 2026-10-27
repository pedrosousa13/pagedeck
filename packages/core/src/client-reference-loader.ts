import { existsSync, readFileSync } from "node:fs";
import { findPackageJSON, registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "rolldown/utils";
import type { ESTree } from "rolldown/utils";
import { getComponent } from "@pagedeck/islands";
import type { ComponentRegistry, HydrationMode } from "@pagedeck/islands";
import { clientReference } from "./client-reference.js";
import { indentFrame } from "./directive-source.js";
import { ConfigError } from "./exit.js";
import { LANG } from "./react-compiler.js";
import { CLIENT_REFERENCE_TARGET } from "./tree.js";

export interface ClientReferenceInstall {
  close(): void;
}

export interface InstallInput {
  clientComponents: Readonly<Record<string, string>>;
  registry: ComponentRegistry;
  config: string;
}

const ORIGINAL_QUERY = "fw-client-original";

/**
 * A registered symbol on `globalThis`, not an import: the generated module is
 * loaded by Node, and this one may be TypeScript under the test runner (#177).
 */
const FACTORY = Symbol.for("@pagedeck/core client reference factory");

interface ExportedName {
  key: string;
  wrap: boolean;
  /** The module and export name the binding comes from, which tells one `export *` name from two. */
  origin: string;
}

interface Proxied {
  id: string;
  name: string;
  mode: HydrationMode;
  exports: readonly ExportedName[];
}

type ModuleShape =
  | { kind: "module"; exports: readonly ExportedName[] }
  | { kind: "commonjs" };

interface Fault {
  module: string;
  text: string;
}

interface Reading {
  faults: Fault[];
  shapes: Map<string, ModuleShape>;
}

type Kind = "function" | "value" | "unknown";

const importers = new Map<string, string>();

/**
 * Before the config loads: a module found loaded before an install can be
 * traced to what imported it only if this saw the import.
 */
export function recordImporters(): void {
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const resolved = nextResolve(specifier, context);
      if (context.parentURL !== undefined && !importers.has(resolved.url)) {
        importers.set(resolved.url, context.parentURL);
      }
      return resolved;
    },
  });
}

export async function installClientReferences(
  input: InstallInput,
): Promise<ClientReferenceInstall> {
  const ids = Object.keys(input.clientComponents).sort();
  if (ids.length === 0) return { close: () => undefined };

  const proxied = new Map<string, Proxied>();
  const reading: Reading = { faults: [], shapes: new Map() };
  for (const id of ids) {
    const name = input.clientComponents[id] as string;
    const url = pathToFileURL(id).href;
    const shape = readShape(id, reading, new Set());
    const exports =
      shape?.kind === "module" ? shape.exports : await evaluatedExports(url);
    proxied.set(url, {
      id,
      name,
      mode: modeFor(input.registry, name),
      exports,
    });
  }
  if (reading.faults.length > 0) throw exportFaults(reading.faults);

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
    await verifyProxied(proxied, generated, pathToFileURL(input.config).href);
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

// Evaluated before the hooks are registered, as every module was before #174:
// CommonJS names are known only once it runs.
async function evaluatedExports(url: string): Promise<ExportedName[]> {
  const namespace = (await import(
    /* @vite-ignore */ `${url}?${ORIGINAL_QUERY}`
  )) as Record<string, unknown>;
  return Object.keys(namespace).map((key) => ({
    key,
    wrap: typeof namespace[key] === "function",
    origin: `${url}#${key}`,
  }));
}

function isCommonJs(path: string, hasModuleSyntax: boolean): boolean {
  const extension = extname(path);
  if (extension === ".cjs" || extension === ".cts") return true;
  if (extension !== ".js" && extension !== ".ts") return false;
  if (hasModuleSyntax) return false;
  const manifest = findPackageJSON(pathToFileURL(path));
  if (manifest === undefined) return true;
  const { type } = JSON.parse(readFileSync(manifest, "utf8")) as {
    type?: unknown;
  };
  return type !== "module";
}

/**
 * Read from the source, never by loading it, so the hooks are in place before
 * any registered module runs (#174). Undefined for a module already being read
 * further up an `export *` chain.
 */
function readShape(
  path: string,
  reading: Reading,
  chain: ReadonlySet<string>,
): ModuleShape | undefined {
  const cached = reading.shapes.get(path);
  if (cached !== undefined) return cached;
  if (chain.has(path)) return undefined;
  const within = new Set([...chain, path]);

  const source = readFileSync(path, "utf8");
  const lang = LANG[extname(path)];
  const parsed = parseSync(
    path,
    source,
    lang === undefined ? { sourceType: "module" } : { lang, sourceType: "module" },
  );
  if (parsed.errors.length > 0) {
    reading.faults.push({
      module: path,
      text: `module "${path}": does not parse, so its exports cannot be read — fix each syntax error the parser names:\n${parsed.errors
        .map((error) => indentFrame((error.codeframe ?? error.message).trim()))
        .join("\n")}`,
    });
    return remember(reading, path, { kind: "module", exports: [] });
  }
  if (isCommonJs(path, parsed.module.hasModuleSyntax)) {
    return remember(reading, path, { kind: "commonjs" });
  }

  const lineOf = (offset: number): number =>
    source.slice(0, offset).split("\n").length;
  const url = pathToFileURL(path).href;
  const body = parsed.program.body;
  const kinds = bindingKinds(body);
  const imported = importedBindings(body);

  const relativeFile = (specifier: string): string | undefined => {
    if (!/^\.\.?\//.test(specifier)) return undefined;
    const file = fileURLToPath(new URL(specifier, url));
    return existsSync(file) ? file : undefined;
  };
  const originOf = (specifier: string, name: string): string => {
    const file = relativeFile(specifier);
    if (file === undefined) return `${specifier}#${name}`;
    const inner = readShape(file, reading, within);
    const found =
      inner?.kind === "module"
        ? inner.exports.find(({ key }) => key === name)
        : undefined;
    return found?.origin ?? `${pathToFileURL(file).href}#${name}`;
  };

  const own = new Map<string, ExportedName>();
  const starred: ExportedName[] = [];
  const set = (key: string, wrap: boolean, origin: string): void => {
    own.set(key, { key, wrap, origin });
  };

  for (const statement of body) {
    switch (statement.type) {
      case "ExportNamedDeclaration": {
        if (statement.exportKind === "type") break;
        if (statement.declaration !== null) {
          for (const [name, kind] of declared(statement.declaration, kinds)) {
            set(name, kind !== "value", `${url}#${name}`);
          }
        }
        for (const specifier of statement.specifiers) {
          if (specifier.exportKind === "type") continue;
          const key = nameOf(specifier.exported);
          const local = nameOf(specifier.local);
          if (statement.source !== null) {
            set(key, true, originOf(statement.source.value, local));
            continue;
          }
          const binding = imported.get(local);
          set(
            key,
            (kinds.get(local) ?? "unknown") !== "value",
            binding === undefined
              ? `${url}#${key}`
              : originOf(binding.specifier, binding.name),
          );
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
        set("default", kind !== "value", `${url}#default`);
        break;
      }
      case "ExportAllDeclaration": {
        if (statement.exportKind === "type") break;
        const specifier = statement.source.value;
        if (statement.exported !== null) {
          set(nameOf(statement.exported), false, originOf(specifier, "*"));
          break;
        }
        const file = relativeFile(specifier);
        const inner =
          file === undefined ? undefined : readShape(file, reading, within);
        if (file !== undefined && inner === undefined) break;
        if (inner?.kind !== "module") {
          reading.faults.push({
            module: path,
            text: `module "${path}" line ${String(lineOf(statement.start))}: export * from "${specifier}" ${
              inner === undefined
                ? "reaches no file by a relative path"
                : "reaches a CommonJS module"
            }, and the build reads the names a "use client" module re-exports without running them — re-export each name instead, as export { Name } from "${specifier}"`,
          });
          break;
        }
        starred.push(...inner.exports.filter(({ key }) => key !== "default"));
        break;
      }
      default:
        break;
    }
  }

  const fromStars = new Map<string, ExportedName>();
  const ambiguous = new Set<string>();
  for (const entry of starred) {
    if (own.has(entry.key)) continue;
    const seen = fromStars.get(entry.key);
    if (seen === undefined) fromStars.set(entry.key, entry);
    else if (seen.origin !== entry.origin) ambiguous.add(entry.key);
  }
  for (const [key, entry] of fromStars) {
    if (!ambiguous.has(key)) own.set(key, entry);
  }
  return remember(reading, path, { kind: "module", exports: [...own.values()] });
}

function remember(
  reading: Reading,
  path: string,
  shape: ModuleShape,
): ModuleShape {
  reading.shapes.set(path, shape);
  return shape;
}

function nameOf(node: ESTree.ModuleExportName): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

function importedBindings(
  body: readonly ESTree.Statement[],
): Map<string, { specifier: string; name: string }> {
  const bindings = new Map<string, { specifier: string; name: string }>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      const name =
        specifier.type === "ImportDefaultSpecifier"
          ? "default"
          : specifier.type === "ImportNamespaceSpecifier"
            ? "*"
            : nameOf(specifier.imported);
      bindings.set(specifier.local.name, {
        specifier: statement.source.value,
        name,
      });
    }
  }
  return bindings;
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
          : boundNames(id).map((name) => [name, "unknown"]),
      );
    case "TSEnumDeclaration":
      return [[node.id.name, "value"]];
    case "TSModuleDeclaration":
      return node.id.type === "Identifier" ? [[node.id.name, "value"]] : [];
    default:
      return [];
  }
}

function boundNames(pattern: ESTree.BindingPattern | ESTree.BindingRestElement): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        boundNames(property.type === "RestElement" ? property : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) =>
        element === null ? [] : boundNames(element),
      );
    case "AssignmentPattern":
      return boundNames(pattern.left);
    case "RestElement":
      return boundNames(pattern.argument);
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

function exportFaults(faults: readonly Fault[]): ConfigError {
  if (faults.length === 1) {
    return new ConfigError(`Island loader: ${(faults[0] as Fault).text}`);
  }
  const modules = new Set(faults.map(({ module }) => module)).size;
  return new ConfigError(
    `Island loader: ${String(faults.length)} faults in ${String(modules)} ${
      modules === 1 ? "module" : "modules"
    } keep the build from reading the exports of the "use client" modules it stands in for — fix each one below:\n${faults
      .map(({ text }) => `  ${text}`)
      .join("\n")}`,
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
  config: string,
): Promise<void> {
  const missed = new Map<string, Proxied>();
  for (const [url, module] of proxied) {
    const namespace = (await import(/* @vite-ignore */ url)) as Record<
      string,
      unknown
    >;
    if (generated.has(url) || isProxied(module, namespace)) continue;
    missed.set(url, module);
  }
  if (missed.size === 0) return;

  const byConfig: string[] = [];
  const byOther: string[] = [];
  for (const [url, module] of missed) {
    const line = `  "${module.name}" — "${module.id}"`;
    const importer = importers.get(url)?.split("?")[0];
    if (importer === config) {
      byConfig.push(line);
      continue;
    }
    const registered =
      importer === undefined ? undefined : proxied.get(importer);
    byOther.push(
      `${line}, ${
        importer === undefined
          ? "imported by a module this process did not see load"
          : registered !== undefined
            ? `imported by "${registered.name}"`
            : `imported by "${importer.startsWith("file:") ? fileURLToPath(importer) : importer}"`
      }`,
    );
  }

  const paragraphs: string[] = [];
  if (byConfig.length > 0) {
    paragraphs.push(
      `Island loader: ${String(byConfig.length)} ${
        byConfig.length === 1
          ? 'module carrying "use client" was already loaded before the build could stand in for it, so nothing another component renders it from would island'
          : 'modules carrying "use client" were already loaded before the build could stand in for them, so nothing another component renders them from would island'
      } — import each through its registry thunk only, and drop the top-level import of it from pagedeck.config.ts:\n${byConfig.sort().join("\n")}`,
    );
  }
  if (byOther.length > 0) {
    paragraphs.push(
      `Island loader: ${String(byOther.length)} ${
        byOther.length === 1
          ? 'module carrying "use client" was already loaded, through the importer named beside it, before the build could stand in for it, so nothing another component renders it from would island'
          : 'modules carrying "use client" were already loaded, through the importer named beside each, before the build could stand in for them, so nothing another component renders them from would island'
      } — load that importer only through a registry thunk, or drop its import:\n${byOther.sort().join("\n")}`,
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
