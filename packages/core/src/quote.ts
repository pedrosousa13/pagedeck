import { escapeUnescapedByJson, printable } from "@pagedeck/content/escape";

const SOURCE_DELIMITER = /[?#]/;

const ADDRESS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:(?:\/\/)?/;

/**
 * Not `ADDRESS_SCHEME`: a bare `scheme:` carries its payload in a path, so its
 * colon stays in the span for `credentialEnd` to read.
 */
const ADDRESS_AUTHORITY = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

/**
 * `lastIndexOf`, never a pattern or `new URL`: nothing in the value says where
 * a credential ends (#378).
 */
function credentialEnd(value: string): number {
  const at = value.lastIndexOf("@");
  if (at === -1) return -1;
  const span = value.slice(0, at).replace(ADDRESS_AUTHORITY, "");
  return !span.includes("/") || span.includes(":") || span.includes("@")
    ? at
    : -1;
}

/**
 * Userinfo is cut before the query: a raw `?` in a password would otherwise end
 * the quote inside the credential.
 */
export function redactSource(value: string): string {
  const userinfo = credentialEnd(value);
  const stripped =
    userinfo === -1
      ? value
      : `${ADDRESS_SCHEME.exec(value)?.[0] ?? ""}…@${value.slice(userinfo + 1)}`;
  const delimiter = stripped.search(SOURCE_DELIMITER);
  return delimiter === -1 ? stripped : `${stripped.slice(0, delimiter + 1)}…`;
}

export function quote(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  const json = JSON.stringify(value, (_key, held: unknown) =>
    typeof held === "string" ? redactSource(held) : held,
  );
  return json === undefined
    ? printable(String(value))
    : escapeUnescapedByJson(json);
}

export function quoteAddress(value: string): string {
  return quote(value);
}

export { quoteIdentifier } from "@pagedeck/content/escape";
