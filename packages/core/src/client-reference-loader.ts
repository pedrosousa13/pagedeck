import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, extname, join } from "node:path";
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

const ORIGINAL_QUERY = "pagedeck-client-original";

/**
 * A registered symbol on `globalThis`, not an import: the generated module is
 * loaded by Node, and this one may be TypeScript under the test runner (#177).
 */
const FACTORY = Symbol.for("@pagedeck/core client reference factory");

interface ExportedName {
  key: string;
  /**
   * Whether the proxy stands in for the export: it does when the export is a
   * function once loaded. Never for a variable initialised with a literal,
   * template, object or array, an enum, a namespace, or `export * as`, which
   * stay live bindings. A mistaken wrap passes a non-function value through.
   */
  wrap: boolean;
  /** The module and export name the binding comes from, which tells one `export *` name from two. */
  origin: string;
}

interface Proxied {
  id: string;
  name: string;
  mode: HydrationMode;
  exports: readonly ExportedName[];
  commonJs: boolean;
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
      commonJs: shape?.kind === "commonjs",
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

// Evaluated before the hooks are registered: CommonJS names are known only
// once it runs.
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

function nearestManifest(directory: string): string | undefined {
  const manifest = join(directory, "package.json");
  if (existsSync(manifest)) return manifest;
  const parent = dirname(directory);
  return parent === directory ? undefined : nearestManifest(parent);
}

function declaredFormat(path: string): "module" | "commonjs" | "detect" {
  const extension = extname(path);
  if (extension === ".cjs" || extension === ".cts") return "commonjs";
  if (extension !== ".js" && extension !== ".ts") return "module";
  const manifest = nearestManifest(dirname(path));
  if (manifest === undefined) return "detect";
  const { type } = JSON.parse(readFileSync(manifest, "utf8")) as {
    type?: unknown;
  };
  return type === "module" ? "module" : type === "commonjs" ? "commonjs" : "detect";
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

  const format = declaredFormat(path);
  if (format === "commonjs") return remember(reading, path, { kind: "commonjs" });
  const source = readFileSync(path, "utf8");
  const lang = LANG[extname(path)];
  const parse = (sourceType: "module" | "commonjs") =>
    parseSync(path, source, lang === undefined ? { sourceType } : { lang, sourceType });
  // Node's own detection: a file it can compile as CommonJS runs as CommonJS.
  if (format === "detect" && parse("commonjs").errors.length === 0) {
    return remember(reading, path, { kind: "commonjs" });
  }
  const parsed = parse("module");
  if (parsed.errors.length > 0) {
    reading.faults.push({
      module: path,
      text: `module "${path}": does not parse, so its exports cannot be read — fix each syntax error the parser names:\n${parsed.errors
        .map((error) => indentFrame((error.codeframe ?? error.message).trim()))
        .join("\n")}`,
    });
    return remember(reading, path, { kind: "module", exports: [] });
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
    `import * as pagedeckOriginal from ${JSON.stringify(original)};`,
    `const pagedeckFactory = globalThis[Symbol.for(${JSON.stringify(FACTORY.description as string)})];`,
  ];
  for (const [at, entry] of module.exports.entries()) {
    if (!entry.wrap) {
      // Re-exported, not copied off the namespace, so a binding stays live.
      lines.push(
        `export { ${exportName(entry.key)} as ${exportName(entry.key)} } from ${JSON.stringify(original)};`,
      );
      continue;
    }
    const local = `pagedeck${String(at)}`;
    const value = `pagedeckOriginal[${JSON.stringify(entry.key)}]`;
    lines.push(
      `const ${local} = typeof ${value} === "function" ? pagedeckFactory(${value}, ${options}) : ${value};`,
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
  const byModule: string[] = [];
  const byCommonJs: string[] = [];
  const unrecorded: string[] = [];
  for (const [url, module] of missed) {
    const line = `  "${module.name}" — "${module.id}"`;
    const importer = importers.get(url)?.split("?")[0];
    const registered =
      importer === undefined ? undefined : proxied.get(importer);
    if (importer === undefined) unrecorded.push(line);
    else if (importer === config) byConfig.push(line);
    else if (registered?.commonJs === true) {
      byCommonJs.push(`${line}, required by "${registered.name}"`);
    } else {
      byModule.push(
        `${line}, imported by "${
          registered !== undefined
            ? registered.name
            : importer.startsWith("file:")
              ? fileURLToPath(importer)
              : importer
        }"`,
      );
    }
  }

  const paragraph = (
    lines: string[],
    how: { one: string; many: string },
    fix: string,
  ): string =>
    `Island loader: ${String(lines.length)} ${
      lines.length === 1
        ? `module carrying "use client" was already loaded${how.one} before the build could stand in for it, so nothing another component renders it from would island`
        : `modules carrying "use client" were already loaded${how.many} before the build could stand in for them, so nothing another component renders them from would island`
    } — ${fix}:\n${lines.sort().join("\n")}`;
  const paragraphs: string[] = [];
  if (byConfig.length > 0) {
    paragraphs.push(
      paragraph(
        byConfig,
        { one: "", many: "" },
        "import each through its registry thunk only, and drop the top-level import of it from pagedeck.config.ts",
      ),
    );
  }
  if (byModule.length > 0) {
    paragraphs.push(
      paragraph(
        byModule,
        {
          one: ", through the importer named beside it,",
          many: ", through the importer named beside each,",
        },
        "load that importer only through a registry thunk, or drop its import",
      ),
    );
  }
  if (byCommonJs.length > 0) {
    paragraphs.push(
      paragraph(
        byCommonJs,
        {
          one: " by a CommonJS module carrying \"use client\", which the build runs to read its exports,",
          many: " by CommonJS modules carrying \"use client\", which the build runs to read their exports,",
        },
        "make the importer named beside each an ES module, or drop the module it requires from build.components",
      ),
    );
  }
  if (unrecorded.length > 0) {
    paragraphs.push(
      paragraph(
        unrecorded,
        { one: "", many: "" },
        "find the module that imports each at top level, most likely pagedeck.config.ts or a module it imports, and load that module only through a registry thunk",
      ),
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
