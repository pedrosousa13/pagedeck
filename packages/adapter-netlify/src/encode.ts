// Every routing-document value reaches `_redirects` and `_headers` through this module, so
// #49's sweep reads one file per adapter. Encoding only: nothing here changes which address a
// value names.

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
