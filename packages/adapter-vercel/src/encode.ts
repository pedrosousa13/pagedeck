// Every routing-document value reaches `vercel.json` through this module, so
// #49's sweep reads one file per adapter. Encoding only: nothing here changes which address a
// value names.

// `redirects[].source`, `headers[].source` and a header prefix all read as path-to-regexp
// (https://vercel.com/docs/project-configuration/vercel-json#redirects), where `:`, `(`, `)`,
// `*`, `+` and `?` are syntax, not literal characters, and Vercel documents no escape for a
// literal one.
const SPECIAL = /[:()*+?]/;

export function unexpressibleInVercelPattern(value: string): string | undefined {
  const found = [...value].find((character) => SPECIAL.test(character));
  return found === undefined
    ? undefined
    : `Vercel reads ${JSON.stringify(found)} in a path pattern as path-to-regexp syntax, and offers no escape for a literal one`;
}

// Identity, and kept so every emitted value passes through this module.
export function vercelPattern(value: string): string {
  return value;
}

// Identity: a header value is checked before any adapter's own grammar runs (#671).
export function vercelHeaderValue(value: string): string {
  return value;
}
