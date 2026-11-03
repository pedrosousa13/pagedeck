import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, inlineScriptFault, scriptRuntimeBase } from "@pagedeck/core";
import type {
  ScriptDeclaration,
  ScriptRuntimeAdapter,
  ScriptRuntimeFile,
  ScriptRuntimeRequest,
} from "@pagedeck/core";
import { partytownSnippet } from "@qwik.dev/partytown/integration";
import type { PartytownConfig } from "@qwik.dev/partytown/integration";
import { libDirPath } from "@qwik.dev/partytown/utils";

export type PartytownForward =
  | string
  | readonly [name: string, settings?: { readonly preserveBehavior?: boolean }];

/** A vendor's https origin, to the path prefix on this site an upstream forwards to it. */
export type PartytownRoutes = Readonly<Record<string, string>>;

export interface PartytownOptions {
  readonly forward?: readonly PartytownForward[];
  readonly resolveUrl?: PartytownRoutes;
  readonly globalFns?: readonly string[];
  readonly mainWindowAccessors?: readonly string[];
  readonly loadScriptsOnMainThread?: readonly (string | RegExp)[];
  readonly fallbackTimeout?: number;
  readonly strictProxyHas?: boolean;
}

export interface PartytownRuntime extends ScriptRuntimeAdapter {
  readonly files: readonly ScriptRuntimeFile[];
  /** The CSP source expression for the snippet every worker page carries. */
  readonly inlineScriptHash: string;
}

/** No `partytown.js`: the snippet inlines it. No Atomics file: service-worker mode only (#275). */
const LIB_FILES = ["partytown-sw.js", "partytown-media.js", "partytown-sandbox-sw.html"];

const WHERE = "Partytown runtime";

const ROUTES_FIX =
  'resolveUrl: { "https://collector.example": "/vendor/collector/" }';

const PATH_PREFIX = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)+$/;

export function definePartytown(options: PartytownOptions = {}): PartytownRuntime {
  const lib = libDirPath();
  const files: readonly ScriptRuntimeFile[] = LIB_FILES.map((name) => ({
    name,
    contents: readFileSync(join(lib, name)),
  }));

  const routes = options.resolveUrl;
  if (routes !== undefined) {
    const report = routesFaultReport(routes);
    if (report !== undefined) throw new ConfigError(report);
  }
  const { resolveUrl: _, ...passed } = options;
  const config = {
    ...passed,
    lib: scriptRuntimeBase(files),
    ...(routes === undefined ? {} : { resolveUrl: resolveUrlFunction(routes) }),
  } as PartytownConfig;
  const snippet = partytownSnippet(config);
  const fault = inlineScriptFault(snippet);
  if (fault !== undefined) {
    throw new ConfigError(
      `${WHERE}: the snippet this config produces ${fault} — the snippet carries forward, globalFns, mainWindowAccessors and loadScriptsOnMainThread as written, so take the sequence out of whichever holds it`,
    );
  }
  const element = `<script>${snippet}</script>`;

  const runtime = ({ scripts }: ScriptRuntimeRequest): readonly string[] => {
    const checked = scripts.filter((script) => script.integrity !== undefined);
    if (checked.length > 0) throw new ConfigError(integrityReport(checked));
    return [element, ...scripts.map(scriptElement)];
  };
  return Object.assign(runtime, {
    files,
    inlineScriptHash: `'sha256-${createHash("sha256").update(snippet, "utf8").digest("base64")}'`,
  });
}

function routesFaultReport(routes: PartytownRoutes): string | undefined {
  const faults: string[] = [];
  for (const [origin, prefix] of Object.entries(routes)) {
    if (!isHttpsOrigin(origin)) {
      faults.push(
        `  ${JSON.stringify(origin)} — not an https origin with nothing after the host`,
      );
    } else if (typeof prefix !== "string" || !isPathPrefix(prefix)) {
      faults.push(
        `  ${JSON.stringify(origin)} → ${JSON.stringify(prefix)} — not a path prefix on this site`,
      );
    }
  }
  if (faults.length === 0) return undefined;
  return `${WHERE}: "resolveUrl" declares ${String(faults.length)} ${
    faults.length === 1 ? "route" : "routes"
  } this runtime cannot take — a route sends a request for one vendor origin to one path prefix on this site, which an upstream forwards to that origin, so a page cannot steer it anywhere else — write each key as the https origin, with no path, and each value as a path prefix that starts and ends with "/", such as ${ROUTES_FIX}:\n${faults.join("\n")}`;
}

function isHttpsOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value;
}

function isPathPrefix(value: string): boolean {
  return PATH_PREFIX.test(value) && !value.split("/").includes("..");
}

/**
 * Source text, not a closure: Partytown serializes the function and rebuilds
 * it inside its worker, where nothing this module closes over exists.
 */
function resolveUrlFunction(routes: PartytownRoutes): (url: URL) => URL | undefined {
  const table = JSON.stringify(routes);
  return new Function(
    "url",
    "location",
    `var routes=${table};if(Object.prototype.hasOwnProperty.call(routes,url.origin))return new URL(routes[url.origin]+url.pathname.slice(1)+url.search,location.href)`,
  ) as (url: URL) => URL | undefined;
}

function integrityReport(scripts: readonly ScriptDeclaration[]): string {
  const subject =
    scripts.length === 1
      ? "1 worker script declares integrity, and Partytown fetches a worker script from inside its worker with no integrity check, so it would load unchecked"
      : `${String(scripts.length)} worker scripts declare integrity, and Partytown fetches a worker script from inside its worker with no integrity check, so each would load unchecked`;
  const fix =
    scripts.length === 1
      ? 'declare strategy: "idle" for it, which keeps the check, or drop integrity'
      : 'declare strategy: "idle" for each, which keeps the check, or drop integrity';
  return `${WHERE}: ${subject} — ${fix}:\n${scripts
    .map(({ name }) => `  ${JSON.stringify(name)}`)
    .join("\n")}`;
}

function scriptElement(script: ScriptDeclaration): string {
  const attributes = Object.entries(script.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return `<script type="text/partytown" src="${escapeAttribute(script.src)}"${attributes}></script>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
