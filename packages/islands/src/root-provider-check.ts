import { reportBrowserFault } from "./browser-report.js";
import type { RootProvider } from "./providers.js";

// Never reads a name: the browser's half is computed from a minified bundle.
function innerTag(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
      return `${typeof value}#${hashed(String(value))}`;
    case "boolean":
      return String(value);
    case "undefined":
      return "undefined";
    case "symbol": {
      const description = (value as symbol).description;
      return description === undefined
        ? "symbol"
        : `symbol#${hashed(description)}`;
    }
    case "function":
      return "function";
    default:
      return "object";
  }
}

// The prototype, not the constructor name, which minification renames.
// `plainContainer` in the probe is a deliberate near-duplicate.
function isPlainContainer(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return (
    prototype === Object.prototype ||
    prototype === null ||
    prototype === Array.prototype
  );
}

function structureText(value: object): string {
  if (Array.isArray(value)) {
    const entries = value as readonly unknown[];
    return `[${entries.map((one) => innerTag(one)).join(", ")}]`;
  }
  const own = value as Record<string, unknown>;
  const fields = Object.keys(own)
    .sort()
    .map((key) => `${key}=${innerTag(own[key])}`);
  return `{${fields.join(", ")}}`;
}

// A read one level down can throw (a getter, a revoked proxy), and this also
// runs in the build, so a throw leaves the bare `object` tag.
function valueTag(value: unknown): string {
  try {
    return isPlainContainer(value)
      ? `object#${hashed(structureText(value))}`
      : innerTag(value);
  } catch {
    return "object";
  }
}

// Hashed so no prop value is quoted (`docs/error-messages.md` rule 6). FNV-1a
// because `SubtleCrypto` is asynchronous and nothing here faces an adversary.
function hashed(text: string): string {
  let hash = 0x81_1c_9d_c5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Providers are named by index, never by component name, which minification
// renames.
export function rootProviderStackDigest(
  providers: readonly RootProvider[],
): string {
  return providers
    .map((provider, at) => {
      const props = provider.props ?? {};
      const fields = Object.keys(props)
        .sort()
        .map((key) => `${key}=${valueTag(props[key])}`);
      return fields.length === 0
        ? `stack[${at}]`
        : `stack[${at}] ${fields.join(", ")}`;
    })
    .join("\n");
}

function providerCount(digest: string): number {
  return digest === "" ? 0 : digest.split("\n").length;
}

function counted(count: number): string {
  return count === 1 ? "1 provider" : `${count} providers`;
}

function quoted(heading: string, digest: string): string {
  const lines = digest === "" ? [] : digest.split("\n");
  return [heading, ...lines.map((line) => `    ${line}`)].join("\n");
}

export function reportRootProviderFault(message: string): void {
  reportBrowserFault(message);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind = typeof value;
  return kind === "object" ? "an object" : `a ${kind}`;
}

// Mirrors `stackFaultLines` in `@pagedeck/core`'s `config.ts`, which this package
// cannot import.
function stackFaultLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [`the default export — ${kindOf(value)}, not an array of providers`];
  }
  return (value as readonly unknown[]).flatMap((provider, index) => {
    const at = `stack[${String(index)}]`;
    if (typeof provider !== "object" || provider === null) {
      return [`${at} — not an object`];
    }
    const one = provider as Record<string, unknown>;
    const component = one["component"];
    const props = one["props"];
    return [
      // `memo`, `forwardRef` and `lazy` all return objects.
      ...(typeof component === "function" ||
      (typeof component === "object" && component !== null)
        ? []
        : [`${at}.component — not a component`]),
      ...(props === undefined ||
      (typeof props === "object" && props !== null && !Array.isArray(props))
        ? []
        : [`${at}.props — not an object`]),
    ];
  });
}

// `unknown` because nothing validates what the module evaluates to. A malformed
// export is reported rather than thrown, so every island still hydrates.
export function checkRootProviders(providers: unknown, built: string): void {
  const faults = stackFaultLines(providers);
  if (faults.length > 0) {
    reportRootProviderFault(
      [
        `Root providers: the module "build.rootProviders.module" default-exports is not a stack this page can apply, so nothing here can check it against the stack this page was built with — default-export the same array of { component, props } that "build.rootProviders.stack" holds, outermost first:`,
        ...faults.map((fault) => `  ${fault}`),
      ].join("\n"),
    );
    return;
  }
  const stack = providers as readonly RootProvider[];
  const imported = rootProviderStackDigest(stack);
  if (imported === built) return;
  reportRootProviderFault(
    [
      `Root providers: the stack this page was built with and the stack the browser imported are not one declaration, so every island root wraps in providers the markup it hydrates was not rendered with — write both halves of "build.rootProviders" from one import in pagedeck.config.ts, and compute no provider prop from a clock, an environment or a random value:`,
      quoted(`  built with ${counted(providerCount(built))}:`, built),
      quoted(`  imported ${counted(stack.length)}:`, imported),
    ].join("\n"),
  );
}
