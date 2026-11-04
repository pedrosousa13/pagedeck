/** The whole data URI, prefix included: what one preview adds to a page's HTML. */
export const MAX_PREVIEW_BYTES = 2048;

const PREVIEW_PREFIX = /^data:image\/(?:png|jpeg|webp|avif|gif);base64,/;

// Nothing here can close a CSS `url("…")`, a declaration or an HTML attribute.
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;

/** `undefined` for an answer safe to emit as a preview; otherwise why it is not. */
export function imagePreviewFault(value: unknown): string | undefined {
  if (typeof value !== "string") return "not a string";
  // A UTF-8 encoding is never shorter than the UTF-16 length.
  if (value.length > MAX_PREVIEW_BYTES) {
    return `at least ${String(value.length)} bytes, over the ${String(MAX_PREVIEW_BYTES)}-byte cap`;
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_PREVIEW_BYTES) {
    return `${String(bytes)} bytes, over the ${String(MAX_PREVIEW_BYTES)}-byte cap`;
  }
  const prefix = PREVIEW_PREFIX.exec(value);
  if (prefix === null) {
    return "not a base64 data URI of a png, jpeg, webp, avif or gif image";
  }
  if (!BASE64.test(value.slice(prefix[0].length))) {
    return "its payload is not base64 — only A-Z, a-z, 0-9, + and / in groups of four, the last padded with =";
  }
  return undefined;
}

const CHANNEL = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

// Strict on purpose: anything looser can add a declaration to the style attribute (#286).
const COLOR = new RegExp(
  `^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgb\\(${CHANNEL}(?: ${CHANNEL}){2}\\)|rgb\\(${CHANNEL}(?:, ${CHANNEL}){2}\\)|rgb\\(${CHANNEL}(?:,${CHANNEL}){2}\\))$`,
);

/** `undefined` for an answer safe to emit as a dominant color; otherwise why it is not. */
export function imageColorFault(value: unknown): string | undefined {
  if (typeof value !== "string") return "not a string";
  if (!COLOR.test(value)) {
    return 'not "#" and 3, 4, 6 or 8 hex digits, or rgb() of three whole numbers from 0 to 255';
  }
  return undefined;
}

const EXCERPT_LENGTH = 32;

/**
 * A refused answer as a message quotes it: an over-cap one is kilobytes of base64.
 * `redact` runs first, since a cut can drop the `@` that marks a credential's end.
 */
export function excerpt(
  value: unknown,
  redact: (text: string) => string,
): unknown {
  if (typeof value !== "string") return value;
  const redacted = redact(value);
  return redacted.length > EXCERPT_LENGTH
    ? `${redacted.slice(0, EXCERPT_LENGTH)}…`
    : redacted;
}
