const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/g;

export function printable(text: string): string {
  return text.replace(CONTROL_CHARACTER, "\u{fffd}");
}

const UNESCAPED_BY_JSON = /[\u007F-\u009F\u2028\u2029]/g;

/** Takes `JSON.stringify` output, so the result still reads back to the same value. */
export function escapeUnescapedByJson(json: string): string {
  return json.replace(
    UNESCAPED_BY_JSON,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Escaped, never cut: `@pagedeck/core`'s `quote` would turn `main@sha256` into
 * `…@sha256` and lose the half that names the build (#321).
 */
export function quoteIdentifier(value: string): string {
  return escapeUnescapedByJson(JSON.stringify(value));
}
