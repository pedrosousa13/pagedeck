import { describeError } from "./exit.js";

export interface ResolveThrow {
  specifier: string;
  error: unknown;
}

function namedPlugin(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, plugin } = error as { code?: unknown; plugin?: unknown };
  return code === "PLUGIN_ERROR" && typeof plugin === "string"
    ? plugin
    : undefined;
}

// Rolldown rejects `this.resolve` with an error of its own naming only the
// specifier, and carries a JavaScript plugin's throw as its cause, marked with
// `code` and `plugin`.
export function pluginError(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  return namedPlugin(cause) === undefined ? error : cause;
}

export interface ResolutionFault {
  lead: string;
  what: string;
  fix: string;
  thrown?: { error: unknown };
}

/** `field` is the config field the specifier came from, if the site wrote it. */
export function threwFault(
  lead: string,
  error: unknown,
  field: string | undefined,
): ResolutionFault {
  const plugin = namedPlugin(error);
  // Unnamed is either Vite's resolver refusing an unexported subpath or a
  // plugin that threw a non-Error, which Rolldown 1.2.13 cannot mark (#189).
  const fix =
    plugin === undefined
      ? field === undefined
        ? "fix the plugin that threw, or the package's exports"
        : `fix the plugin that threw, or ${field}`
      : field === undefined
        ? "fix that plugin"
        : `fix that plugin, or ${field}`;
  return {
    lead,
    what:
      plugin === undefined
        ? "a resolveId hook threw (a plugin, or the resolver refusing a subpath the package does not export)"
        : `plugin "${plugin}" threw`,
    fix,
    thrown: { error },
  };
}

export const COMPONENT_FIELD =
  "the component's path or specifier in build.components";

/** For faults holding at least one throw. */
export function resolutionFailure(input: {
  where: string;
  noun: { one: string; many: string };
  against?: string;
  faults: readonly ResolutionFault[];
}): Error {
  const { faults } = input;
  const lone = faults.length === 1;
  const throws = faults.filter((fault) => fault.thrown !== undefined).length;
  const because =
    throws === 1 ? "a resolveId hook threw" : "resolveId hooks threw";
  const lines = faults.map((fault) => {
    const line = `  ${fault.lead} — ${fault.what} — ${fault.fix}`;
    return fault.thrown === undefined || lone
      ? line
      : `${line}:\n    ${describeError(fault.thrown.error).split("\n").join("\n    ")}`;
  });
  const message = `${input.where}: ${String(faults.length)} ${
    lone ? input.noun.one : input.noun.many
  } did not resolve${
    input.against === undefined ? "" : ` against "${input.against}"`
  }, ${
    throws === faults.length ? "" : `${String(throws)} of them `
  }because ${because} — fix ${lone ? "it" : "each"} as its line says:\n${lines.join("\n")}`;
  const cause = lone ? faults[0]?.thrown : undefined;
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause: cause.error });
}
