// The loader's hash is pinned from the build's `inlineScriptHashes`: core keeps its
// composition internal. `'unsafe-inline'` styles are core's `<pagedeck-island style>` (#577).
const SCRIPT_LOADER_HASH = "'sha256-g4oY1TPDYfr8MTWvLO7SQ/0ajmFgkN+YZtHwspL4QLQ='";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' https://consent.example https://analytics.example ${SCRIPT_LOADER_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
