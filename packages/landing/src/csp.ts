// Pinned: core keeps the loader's composition internal, so the hash is copied
// from the manifest, and `site.build.test.ts` fails when it goes stale.
const FACADE_LOADER_HASH = "'sha256-nDzs2CUaBUH8lVSWkaSI/d1UaCtKcTfHbRKUIcp7buQ='";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${FACADE_LOADER_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
