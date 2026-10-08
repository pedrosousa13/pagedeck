// Pinned: core keeps the loader's composition internal, so the hash is copied
// from the manifest, and `site.build.test.ts` fails when it goes stale.
const FACADE_LOADER_HASH = "'sha256-nDzs2CUaBUH8lVSWkaSI/d1UaCtKcTfHbRKUIcp7buQ='";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${FACADE_LOADER_HASH}`,
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer",
  "bluetooth",
  "camera",
  "display-capture",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "hid",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
]
  .map((feature) => `${feature}=()`)
  .join(", ");

export const DOCUMENT_HEADERS = [
  { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { name: "Permissions-Policy", value: PERMISSIONS_POLICY },
  { name: "Cross-Origin-Opener-Policy", value: "same-origin" },
] as const;
