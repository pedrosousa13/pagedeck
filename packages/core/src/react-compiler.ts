import { isAbsolute, relative, sep } from "node:path";
import { transformSync } from "@babel/core";
import type { PluginObj } from "@babel/core";
import reactCompiler, { OPT_OUT_DIRECTIVES } from "babel-plugin-react-compiler";
import type {
  CompilerDiagnostic,
  CompilerErrorDetail,
  PluginOptions,
} from "babel-plugin-react-compiler";
import type { Plugin } from "vite";

const SCRIPT = /\.[cm]?[jt]sx?$/;

const REACT_RUNTIME = new Set(["react", "react-dom", "scheduler"]);

function packageOf(path: string): string | undefined {
  const segments = path.split(/[/\\]/);
  const last = segments.lastIndexOf("node_modules");
  if (last === -1) return undefined;
  const name = segments[last + 1];
  return name?.startsWith("@") === true ? `${name}/${segments[last + 2] ?? ""}` : name;
}

/** No JSX for `.ts`: there `<T>value` is a type assertion, not an element. */
function parserPlugins(path: string): ("jsx" | "typescript")[] {
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
    return ["typescript"];
  }
  return ["jsx", "typescript"];
}

function lineOf(
  detail: CompilerDiagnostic | CompilerErrorDetail,
): number | undefined {
  const loc = detail.primaryLocation();
  return typeof loc === "object" && loc !== null ? loc.start.line : undefined;
}

function componentName(
  source: string,
  fnLoc: { start: { line: number } } | null,
): string | undefined {
  if (fnLoc === null) return undefined;
  const line = source.split("\n")[fnLoc.start.line - 1];
  const declared = line?.match(
    /\b(?:function|class)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  );
  return declared?.[1] ?? declared?.[2];
}

function bailoutWarning(
  moduleId: string,
  source: string,
  event: { fnLoc: { start: { line: number } } | null },
  detail: CompilerDiagnostic | CompilerErrorDetail,
): string {
  const line = lineOf(detail);
  const where = line === undefined ? "" : ` line ${line}`;
  const name = componentName(source, event.fnLoc);
  const which = name === undefined ? "a component" : `component "${name}"`;
  const fix =
    detail.description ??
    'rewrite it so the rule holds, or add "use no memo" to keep it as written on purpose';
  return `Module "${moduleId}"${where}: React Compiler skipped ${which} — ${detail.reason}: ${fix}. It renders as written, without automatic memoization.`;
}

function crashWarning(
  moduleId: string,
  source: string,
  event: { fnLoc: { start: { line: number } } | null; data: string },
): string {
  const where = event.fnLoc === null ? "" : ` line ${event.fnLoc.start.line}`;
  const name = componentName(source, event.fnLoc);
  const which = name === undefined ? "a component" : `component "${name}"`;
  const newline = event.data.indexOf("\n");
  const crash = newline === -1 ? event.data : event.data.slice(0, newline);
  return `Module "${moduleId}"${where}: React Compiler crashed on ${which} — ${crash}. That is a fault in the compiler rather than a rule the component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash is logged whether or not the directive is present. It renders as written, without automatic memoization.`;
}

function disablesMemo(directive: { value: { value: string } }): boolean {
  return OPT_OUT_DIRECTIVES.has(directive.value.value);
}

function positionOf(
  loc: { start: { line: number; column: number } } | null | undefined,
): string | undefined {
  return loc == null ? undefined : `${loc.start.line}:${loc.start.column}`;
}

function isAuthored(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return !rel.split(sep).includes("node_modules");
}

export interface IslandCompilation {
  plugin: Plugin;
  taken(): readonly string[];
}

export function compileIslands(): IslandCompilation {
  let root = process.cwd();
  const warned = new Map<string, string[]>();
  const warn = (id: string, warning: string): void => {
    const module = warned.get(id);
    if (module === undefined) warned.set(id, [warning]);
    else module.push(warning);
  };
  const plugin: Plugin = {
    name: "pagedeck:compile-islands",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
    },

    // Cleared per build: one plugin instance may serve several builds.
    buildStart() {
      warned.clear();
    },

    transform(code, id) {
      const path = id.split("?")[0] ?? id;
      if (!SCRIPT.test(path)) return null;
      // Compiling React itself changes nothing and makes Babel print a note (#70).
      if (REACT_RUNTIME.has(packageOf(path) ?? "")) return null;

      const logged: { warning: string; bailoutIn?: string | undefined }[] = [];
      const options: PluginOptions = {
        target: "19",
        // The default skips `node_modules`, where a design system's islands
        // live.
        sources: () => true,
        logger: {
          logEvent: (_filename, event) => {
            // A bailout warns only in the author's modules; a crash is a
            // compiler bug to report wherever the module came from (#106).
            if (event.kind === "CompileError") {
              if (isAuthored(root, path)) {
                logged.push({
                  warning: bailoutWarning(id, code, event, event.detail),
                  bailoutIn: positionOf(event.fnLoc),
                });
              }
            } else if (event.kind === "PipelineError") {
              logged.push({ warning: crashWarning(id, code, event) });
            }
          },
        },
      };
      // The compiler logs a bailout even for a function it leaves as written
      // on request (#165).
      let moduleOptedOut = false;
      const optedOut = new Set<string>();
      const findOptOuts: PluginObj = {
        pre(file) {
          moduleOptedOut = file.path.node.directives.some(disablesMemo);
          file.path.traverse({
            Function(fn) {
              const body = fn.node.body;
              const position = positionOf(fn.node.loc);
              if (
                position !== undefined &&
                body.type === "BlockStatement" &&
                body.directives.some(disablesMemo)
              ) {
                optedOut.add(position);
              }
            },
          });
        },
        visitor: {},
      };
      const compiled = transformSync(code, {
        filename: path,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins: parserPlugins(path) },
        plugins: [findOptOuts, [reactCompiler, options]],
      });
      for (const { warning, bailoutIn } of logged) {
        const asked =
          bailoutIn !== undefined && (moduleOptedOut || optedOut.has(bailoutIn));
        if (!asked) warn(id, warning);
      }
      if (compiled?.code == null) return null;
      return { code: compiled.code, map: compiled.map };
    },
  };
  return {
    plugin,
    taken: () =>
      [...warned]
        .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
        .flatMap(([, module]) => module),
  };
}
