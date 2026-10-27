// No inline script on any page, so no hash: `site.build.test.ts` fails when one appears.
// `style-src-attr 'unsafe-inline'` is for the island wrapper's `style="display:contents"`.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
