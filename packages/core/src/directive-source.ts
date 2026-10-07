import { parseAst } from "vite";
import { ConfigError } from "./exit.js";
import type { Directive } from "./directives.js";

function dialect(moduleId: string): "ts" | "tsx" | "jsx" {
  const path = moduleId.split("?")[0] ?? moduleId;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
    return "ts";
  }
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "jsx";
  }
  return "tsx";
}

export const UNPARSABLE_REFUSAL =
  'will not parse, so the scan cannot tell whether a "use client" boundary is declared — fix the syntax error the parser names';

export function readDirective(
  moduleId: string,
  source: string,
): Directive | undefined {
  let program;
  try {
    program = parseAst(source, { lang: dialect(moduleId) });
  } catch (cause) {
    throw new ConfigError(`Module "${moduleId}": ${UNPARSABLE_REFUSAL}`, {
      cause,
    });
  }
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement") break;
    const declared = statement.directive;
    if (declared === undefined) break;
    if (declared === "use client" || declared === "use server") return declared;
  }
  return undefined;
}

export function readResourceImports(
  moduleId: string,
  source: string,
): readonly string[] {
  let program;
  try {
    program = parseAst(source, { lang: dialect(moduleId) });
  } catch (cause) {
    throw new ConfigError(`Module "${moduleId}": ${UNPARSABLE_REFUSAL}`, {
      cause,
    });
  }
  const found = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.source.value !== "react-dom") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = specifier.imported;
      const name =
        imported.type === "Identifier" ? imported.name : imported.value;
      if (typeof name !== "string") continue;
      if (RESOURCE_PLACERS.has(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * `preload` and `preloadModule` are deliberately absent: they emit a hint, not
 * a stylesheet.
 */
const RESOURCE_PLACERS: ReadonlySet<string> = new Set([
  "preinit",
  "preinitModule",
]);
