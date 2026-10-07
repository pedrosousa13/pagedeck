// Every routing-document value reaches `_redirects` and `_headers` through this module, so
// #49's sweep reads one file per adapter. Encoding only: nothing here changes which address a
// value names.

// Cloudflare reads "*" as a splat and a path segment beginning ":" as a placeholder, with no
// escape for a literal one of either
// (https://developers.cloudflare.com/pages/configuration/redirects/#splats,
// https://developers.cloudflare.com/pages/configuration/redirects/#placeholders).
export function unexpressibleInCloudflarePagesPattern(
  value: string,
): string | undefined {
  if (value.includes("*")) {
    return 'Cloudflare Pages reads "*" in a path pattern as a splat, and offers no escape for a literal one';
  }
  if (value.split("/").some((segment) => segment.startsWith(":"))) {
    return 'Cloudflare Pages reads a path segment beginning ":" as a placeholder, and offers no escape for a literal one';
  }
  return undefined;
}

// Identity, and kept so every emitted value passes through this module.
export function cloudflarePagesPattern(value: string): string {
  return value;
}
