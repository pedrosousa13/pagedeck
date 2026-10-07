// Every routing-document value reaches `_redirects` and `_headers` through this module, so
// #49's sweep reads one file per adapter. Encoding only: nothing here changes which address a
// value names.

import type { RedirectStatus } from "@pagedeck/core/routing";

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

// Identity: a header value is checked before any adapter's own grammar runs (#671).
export function netlifyHeaderValue(value: string): string {
  return value;
}

// https://docs.netlify.com/manage/routing/redirects/redirect-options/ supports only 301, 302,
// 200 and 404; mapped rather than refused (#10), to the status of the same permanence.
export function netlifyStatus(status: RedirectStatus): RedirectStatus {
  if (status === 308) return 301;
  if (status === 307) return 302;
  return status;
}
