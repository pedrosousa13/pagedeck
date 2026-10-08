const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HEX_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

/** The email and account ID wrangler prints must stay out of a public log (#59). */
export function redactToolOutput(text: string): string {
  return text.replace(EMAIL, "<email>").replace(HEX_ID, "<id>");
}
