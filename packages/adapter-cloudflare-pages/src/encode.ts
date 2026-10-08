// Every routing-document value reaches `_redirects` and `_headers` through this module, so
// #49's sweep reads one file per adapter. Encoding only: nothing here changes which address a
// value names.

// Cloudflare reads "*" as a splat and a path segment beginning ":" as a placeholder, with no
// escape for a literal one of either
// (https://developers.cloudflare.com/pages/configuration/redirects/#splats,
// https://developers.cloudflare.com/pages/configuration/redirects/#placeholders). Every ":" is
// refused, since no rule says a mid-segment one is literal (#41). Whitespace ends a path in
// `_redirects` and `_headers`.
const WHITESPACE = /\p{White_Space}/u;

export function unexpressibleInCloudflarePagesPattern(
  value: string,
): string | undefined {
  if (value.includes("*")) {
    return 'Cloudflare Pages reads "*" in a path pattern as a splat, and offers no escape for a literal one';
  }
  if (value.includes(":")) {
    return 'Cloudflare Pages reads ":" in a path pattern as the start of a placeholder, and offers no escape for a literal one';
  }
  const space = WHITESPACE.exec(value)?.[0];
  if (space !== undefined) {
    const point = (space.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return `Cloudflare Pages reads U+${point}, a whitespace character, as the end of a path pattern, and offers no escape for a literal one`;
  }
  return undefined;
}

// Identity, and kept so every emitted value passes through this module.
export function cloudflarePagesPattern(value: string): string {
  return value;
}
