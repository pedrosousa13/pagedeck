// Every routing-document value reaches `routing.conf` through this module, so #49's sweep
// reads one file per adapter. Encoding only: nothing here changes which address a value names.

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
