// Encoding only: nothing here changes which address a value names.

// Past `JSON.stringify`: `</` closes an enclosing element, and U+2028 and U+2029 end a line
// in JavaScript.
export function jsLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("</", "<\\/")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
