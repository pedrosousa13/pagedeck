export const DIAGNOSTIC_MARKER = "pagedeck:";

export function markDiagnostic(text: string): string {
  return text
    .split("\n")
    .map((line) => `${DIAGNOSTIC_MARKER} ${line}`)
    .join("\n");
}
