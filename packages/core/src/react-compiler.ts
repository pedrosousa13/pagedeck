import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { extname, isAbsolute, relative, sep } from "node:path";
import { parseAst } from "rolldown/parseAst";
import type { Plugin } from "vite";
import { ConfigError } from "./exit.js";
import type {
  CompileReply,
  CompileRequest,
  Diagnostic,
  Lang,
} from "./react-compiler-worker.js";

// The slowest real module measured, `packages/core/src/build.ts` at 93 kB,
// compiles in 5 ms; a module past this is a runaway (#164).
export const MODULE_TIME_LIMIT_MS = 5_000;

// Under Vitest this module runs from `src`, where Node strips the worker's types.
const WORKER = new URL(
  import.meta.url.endsWith(".ts")
    ? "./react-compiler-worker.ts"
    : "./react-compiler-worker.js",
  import.meta.url,
);

// Oxc reads the language off the extension, refuses JSX in a `.js` file and
// reads `<T>value` in a `.mts` file as JSX.
export const LANG: Readonly<Record<string, Lang>> = {
  ".js": "jsx",
  ".mjs": "jsx",
  ".cjs": "jsx",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
};

const REACT_RUNTIME = new Set(["react", "react-dom", "scheduler"]);

const OPT_OUT_DIRECTIVES = new Set(["use no memo", "use no forget"]);

type Outcome =
  | {
      kind: "compiled";
      code: string;
      map: CompileReply["map"];
      diagnostics: readonly Diagnostic[];
    }
  | { kind: "fatal"; diagnostics: readonly Diagnostic[] }
  | { kind: "crashed"; signal: NodeJS.Signals | null; code: number | null }
  | { kind: "timedOut"; limitMs: number }
  | { kind: "stopped" };

interface Pending {
  request: CompileRequest;
  resolve: (outcome: Outcome) => void;
  reject: (error: Error) => void;
}

type Child =
  | { state: "none" }
  | { state: "idle"; process: ChildProcess }
  | {
      state: "busy";
      process: ChildProcess;
      pending: Pending;
      timer: NodeJS.Timeout;
    };

interface CompilerProcess {
  compile(request: CompileRequest): Promise<Outcome>;
  stop(): void;
}

function isReply(value: unknown): value is CompileReply {
  const reply = value as Partial<CompileReply> | null;
  return (
    typeof reply === "object" &&
    reply !== null &&
    typeof reply.fatal === "boolean" &&
    typeof reply.code === "string" &&
    Array.isArray(reply.diagnostics)
  );
}

function outcomeOf(reply: CompileReply): Outcome {
  return reply.fatal
    ? { kind: "fatal", diagnostics: reply.diagnostics }
    : {
        kind: "compiled",
        code: reply.code,
        map: reply.map,
        diagnostics: reply.diagnostics,
      };
}

/** One module at a time, so the time limit measures that module alone. */
function compilerProcess(limitMs: number): CompilerProcess {
  let child: Child = { state: "none" };
  const queue: Pending[] = [];

  const spawn = (): ChildProcess => {
    const worker = fork(WORKER, [], { execArgv: [] });
    worker.unref();
    worker.on("message", (reply: unknown) => {
      if (child.state !== "busy" || child.process !== worker) return;
      if (!isReply(reply)) return;
      clearTimeout(child.timer);
      const { pending } = child;
      child = { state: "idle", process: worker };
      worker.channel?.unref();
      pending.resolve(outcomeOf(reply));
      pump();
    });
    worker.on("exit", (code, signal) => {
      if (child.state === "none" || child.process !== worker) return;
      const was = child;
      child = { state: "none" };
      if (was.state === "busy") {
        clearTimeout(was.timer);
        was.pending.resolve({ kind: "crashed", signal, code });
      }
      pump();
    });
    worker.on("error", (error) => {
      if (child.state === "none" || child.process !== worker) return;
      const was = child;
      child = { state: "none" };
      if (was.state === "busy") {
        clearTimeout(was.timer);
        was.pending.reject(
          new Error(
            `Module "${was.pending.request.filename}": React Compiler's process could not be reached — this is a framework fault, not a site one; report it against @pagedeck/core`,
            { cause: error },
          ),
        );
      }
      pump();
    });
    return worker;
  };

  const pump = (): void => {
    if (child.state === "busy") return;
    const pending = queue.shift();
    if (pending === undefined) return;
    const worker = child.state === "idle" ? child.process : spawn();
    const timer = setTimeout(() => {
      child = { state: "none" };
      worker.kill("SIGKILL");
      pending.resolve({ kind: "timedOut", limitMs });
      pump();
    }, limitMs);
    child = { state: "busy", process: worker, pending, timer };
    worker.channel?.ref();
    worker.send(pending.request);
  };

  return {
    compile: (request) =>
      new Promise<Outcome>((resolve, reject) => {
        queue.push({ request, resolve, reject });
        pump();
      }),
    stop: () => {
      for (const pending of queue.splice(0)) pending.resolve({ kind: "stopped" });
      if (child.state === "none") return;
      const was = child;
      child = { state: "none" };
      was.process.kill("SIGKILL");
      if (was.state === "busy") {
        clearTimeout(was.timer);
        was.pending.resolve({ kind: "stopped" });
      }
    },
  };
}

function packageOf(path: string): string | undefined {
  const segments = path.split(/[/\\]/);
  const last = segments.lastIndexOf("node_modules");
  if (last === -1) return undefined;
  const name = segments[last + 1];
  return name?.startsWith("@") === true ? `${name}/${segments[last + 2] ?? ""}` : name;
}

function isAuthored(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return !rel.split(sep).includes("node_modules");
}

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).type === "string" &&
    typeof (value as Node).start === "number" &&
    typeof (value as Node).end === "number"
  );
}

function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function optsOut(statements: unknown): boolean {
  if (!Array.isArray(statements)) return false;
  for (const statement of statements) {
    if (!isNode(statement) || statement.type !== "ExpressionStatement") break;
    const directive = statement["directive"];
    if (typeof directive !== "string") break;
    if (OPT_OUT_DIRECTIVES.has(directive)) return true;
  }
  return false;
}

function nameOf(fn: Node, parent: Node | undefined): string | undefined {
  const id = fn["id"];
  if (isNode(id) && typeof id["name"] === "string") return id["name"];
  if (parent?.type !== "VariableDeclarator") return undefined;
  const declared = parent["id"];
  return isNode(declared) && typeof declared["name"] === "string"
    ? declared["name"]
    : undefined;
}

/** Oxc reports UTF-8 byte offsets; the AST and `String` index UTF-16. */
function indexOf(code: string, byteStart: number): number {
  return Buffer.from(code, "utf8").subarray(0, byteStart).toString("utf8")
    .length;
}

function lineOf(code: string, byteStart: number | undefined): number | undefined {
  return byteStart === undefined
    ? undefined
    : code.slice(0, indexOf(code, byteStart)).split("\n").length;
}

interface Site {
  line: number | undefined;
  component: string | undefined;
  optedOut: boolean;
}

/** Where a diagnostic sits: its line, the outermost named function around it,
 * and whether that function, one inside it, or the module opted out. */
function locate(
  program: Node,
  code: string,
  byteStart: number | undefined,
): Site {
  let optedOut = optsOut(program["body"]);
  const line = lineOf(code, byteStart);
  if (byteStart === undefined) return { line, component: undefined, optedOut };
  const index = indexOf(code, byteStart);
  let component: string | undefined;
  let parent: Node | undefined;
  let node: Node | undefined = program;
  while (node !== undefined) {
    if (FUNCTIONS.has(node.type)) {
      component ??= nameOf(node, parent);
      const body = node["body"];
      if (isNode(body) && optsOut(body["body"])) optedOut = true;
    }
    parent = node;
    node = children(node).find(
      (child) => child.start <= index && index < child.end,
    );
  }
  return { line, component, optedOut };
}

function bailoutWarning(
  moduleId: string,
  site: Site,
  diagnostic: Diagnostic,
): string {
  const where = site.line === undefined ? "" : ` line ${String(site.line)}`;
  const which =
    site.component === undefined ? "a component" : `component "${site.component}"`;
  const fix =
    diagnostic.help ??
    'rewrite it so the rule holds, or add "use no memo" to keep it as written on purpose';
  return `Module "${moduleId}"${where}: React Compiler skipped ${which} — ${diagnostic.message}: ${fix}. It renders as written, without automatic memoization.`;
}

function crashWarning(moduleId: string, how: string): string {
  return `Module "${moduleId}": React Compiler crashed — its process ${how} while compiling the module. That is a fault in the compiler rather than a rule a component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash happens whether or not the directive is present. The module renders as written, without automatic memoization.`;
}

function fatalError(
  moduleId: string,
  code: string,
  diagnostics: readonly Diagnostic[],
): ConfigError {
  const lines = diagnostics.map((diagnostic) => {
    const line = lineOf(code, diagnostic.byteStart);
    const where = line === undefined ? "" : `line ${String(line)}: `;
    const help = diagnostic.help === null ? "" : ` — ${diagnostic.help}`;
    return `  ${where}${diagnostic.message}${help}`;
  });
  const count = diagnostics.length;
  return new ConfigError(
    `Module "${moduleId}": React Compiler stopped on ${String(count)} fatal diagnostic${count === 1 ? "" : "s"} and produced no code — correct each line below, then build again:\n${lines.join("\n")}`,
  );
}

export interface IslandCompilation {
  plugin: Plugin;
  /** Every warning since `buildStart`, in module id order. */
  taken(): readonly string[];
}

export interface CompileIslandsOptions {
  moduleTimeLimitMs?: number;
  /** Each warning as it is raised, and a fatal's message before it is thrown. */
  err?: (line: string) => void;
}

export function compileIslands({
  moduleTimeLimitMs = MODULE_TIME_LIMIT_MS,
  err,
}: CompileIslandsOptions = {}): IslandCompilation {
  let root = process.cwd();
  const warned = new Map<string, string[]>();
  const warn = (id: string, warning: string): void => {
    const module = warned.get(id);
    if (module === undefined) warned.set(id, [warning]);
    else module.push(warning);
    err?.(warning);
  };
  const compiler = compilerProcess(moduleTimeLimitMs);

  const report = (
    id: string,
    path: string,
    lang: Lang,
    code: string,
    outcome: Outcome,
  ): { code: string; map: CompileReply["map"] } | null => {
    if (outcome.kind === "stopped") return null;
    // A dev server transforms a module again after each edit.
    warned.delete(id);
    switch (outcome.kind) {
      case "compiled": {
        // A bailout warns only in the author's modules (#106), and not for a
        // function the compiler left as written on request (#165). Parsed only
        // then, which is rare.
        if (outcome.diagnostics.length > 0 && isAuthored(root, path)) {
          const program = parseAst(code, { lang }, path) as unknown as Node;
          for (const diagnostic of outcome.diagnostics) {
            const site = locate(program, code, diagnostic.byteStart);
            if (!site.optedOut) warn(id, bailoutWarning(id, site, diagnostic));
          }
        }
        return { code: outcome.code, map: outcome.map };
      }
      case "fatal": {
        // A throw in a dev hook loses its class and reaches no channel
        // (AGENTS.md, "One door onto the bundler").
        const fatal = fatalError(id, code, outcome.diagnostics);
        err?.(fatal.message);
        throw fatal;
      }
      case "crashed":
        warn(
          id,
          crashWarning(
            id,
            outcome.signal === null
              ? `exited with code ${String(outcome.code)}`
              : `exited on ${outcome.signal}`,
          ),
        );
        return null;
      case "timedOut":
        warn(
          id,
          crashWarning(id, `ran past ${String(outcome.limitMs / 1000)} s`),
        );
        return null;
    }
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
      const lang = LANG[extname(path)];
      if (lang === undefined) return null;
      // Compiling React itself changes nothing (#70).
      if (REACT_RUNTIME.has(packageOf(path) ?? "")) return null;
      return compiler
        .compile({ filename: path, code, lang })
        .then((outcome) => report(id, path, lang, code, outcome));
    },

    // Runs on a failed build too.
    buildEnd() {
      compiler.stop();
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
