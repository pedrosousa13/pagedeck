// `console.error` even for warnings: some console filters hide `warn`, and every
// headless capture here collects `error`.
export function reportBrowserFault(message: string): void {
  console.error(message);
}
