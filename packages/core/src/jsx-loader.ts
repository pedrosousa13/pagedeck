import { registerHooks, setSourceMapsSupport } from "node:module";
import type { LoadHookSync } from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";
import { ConfigError } from "./exit.js";

const JSX_MODULE = /\.[jt]sx$/;

const ANSI = /\u001b\[[0-9;]*m/g;

export function installJsxLoader(): void {
  setSourceMapsSupport(true);
  registerHooks({ load: jsxLoad });
}

export const jsxLoad: LoadHookSync = (url, context, nextLoad) => {
  const path = sitePath(url);
  if (path === undefined) return nextLoad(url, context);
  const { source } = nextLoad(url, { ...context, format: "module" });
  return {
    format: "module",
    shortCircuit: true,
    source: compile(path, String(source)),
  };
};

function sitePath(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  const path = fileURLToPath(url);
  if (!JSX_MODULE.test(path)) return undefined;
  if (path.split(sep).includes("node_modules")) return undefined;
  return path;
}

function compile(path: string, source: string): string {
  const result = transformSync(path, source, {
    jsx: { runtime: "automatic", development: false },
    sourcemap: true,
  });
  if (result.errors.length > 0) throw compileFault(path, result.errors);
  const map = Buffer.from(JSON.stringify(result.map)).toString("base64");
  return `${result.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n`;
}

// The cause aggregates rolldown's errors rather than being one: `describeError`
// prints a cause's message, and theirs is a coloured, multi-line code frame.
function compileFault(path: string, errors: readonly Error[]): ConfigError {
  const faults = errors.map((error) => {
    const text = (error.message.replace(ANSI, "").split("\n")[0] ?? "").replace(
      /^\[[A-Z_]+\] /,
      "",
    );
    // Typed as a plain `Error`, but carries the position (#702).
    const at = (error as Error & { loc?: { line: number; column: number } })
      .loc;
    return { at, text };
  });
  const [only] = faults;
  if (faults.length === 1 && only?.at !== undefined) {
    return new ConfigError(
      `Module "${path}" line ${String(only.at.line)}: does not compile — fix the syntax at the line named`,
      {
        cause: new AggregateError(
          errors,
          `column ${String(only.at.column + 1)}: ${only.text}`,
        ),
      },
    );
  }
  const listed = faults.map(({ at, text }) =>
    at === undefined
      ? text
      : `line ${String(at.line)}, column ${String(at.column + 1)}: ${text}`,
  );
  return new ConfigError(
    `Module "${path}": ${String(faults.length)} syntax error${faults.length === 1 ? "" : "s"}, so it does not compile — fix the syntax at each line named`,
    { cause: new AggregateError(errors, listed.join("; ")) },
  );
}
