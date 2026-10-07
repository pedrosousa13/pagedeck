// `tabindex="0"` so a keyboard reader can scroll a wide block too.
const TABLE = /<table\b[\s\S]*?<\/table>/g;

export function wrapTables(html: string): string {
  return html.replace(
    TABLE,
    (table) => `<div class="fw-table" tabindex="0">${table}</div>`,
  );
}

export function focusablePre(html: string): string {
  return html.replaceAll("<pre>", '<pre tabindex="0">');
}
