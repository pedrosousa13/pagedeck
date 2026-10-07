// Every routing-document value reaches output text through this module, so #49's sweep reads
// one file. Encoding only: nothing here changes which address a value names.

// Past `JSON.stringify`: `</` closes an enclosing element, and U+2028 and U+2029 end a line
// in JavaScript.
export function jsLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("</", "<\\/")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

// Netlify gives `*` and a leading `:` meaning with no escape, and `%2A` is another address.
export function unexpressibleInNetlifyPattern(
  value: string,
): string | undefined {
  if (value.includes("*")) {
    return 'Netlify reads "*" in a path pattern as a splat, and offers no escape for a literal one';
  }
  if (value.split("/").some((segment) => segment.startsWith(":"))) {
    return 'Netlify reads a path segment beginning ":" as a placeholder, and offers no escape for a literal one';
  }
  return undefined;
}

// Identity, and kept so every emitted value passes through this module.
export function netlifyPattern(value: string): string {
  return value;
}

// Identity: a header value is checked before any target runs (#671).
export function netlifyHeaderValue(value: string): string {
  return value;
}

// nginx interpolates `$` in a quoted string and has no escape for a literal one.
export function unexpressibleInNginx(value: string): string | undefined {
  return value.includes("$")
    ? 'nginx interpolates "$" inside a quoted string, and offers no escape for a literal one'
    : undefined;
}

// `\` first, or the escapes added after it would be escaped again.
export function nginxLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Swallows a decode failure: `unexpressibleInNginxLocation` already recorded it as a fault.
function nginxDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const CONTROL = /[\u0000-\u001F\u007F]/;

// nginx matches the decoded URI, so `%24` becomes a variable. `%2F` is refused: decoding it
// would turn one segment into two (ADR-0003).
export function unexpressibleInNginxLocation(
  value: string,
): string | undefined {
  if (/%2f/i.test(value)) {
    return 'nginx decodes the request URI before it selects a location, so an escaped "%2F" cannot be told apart from a real path separator';
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "nginx decodes the request URI as bytes, and this path holds a percent-escape that is not valid UTF-8";
  }
  if (CONTROL.test(decoded)) {
    return "nginx decodes the request URI before it selects a location, and the decoded path holds a control character no directive can carry";
  }
  return unexpressibleInNginx(decoded);
}

// Decoded, because nginx matches after decoding; written escaped, a non-ASCII route matches
// nothing.
export function nginxLocation(value: string): string {
  return nginxLiteral(nginxDecode(value));
}
