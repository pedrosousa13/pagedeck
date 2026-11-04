const HTML = "text/html; charset=utf-8";
const JAVASCRIPT = "text/javascript; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

export const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", HTML],
  [".js", JAVASCRIPT],
  [".mjs", JAVASCRIPT],
  [".css", "text/css; charset=utf-8"],
  [".json", JSON_TYPE],
  [".map", JSON_TYPE],
  [".webmanifest", "application/manifest+json"],
  [".xml", "application/xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
]);

export function contentTypeOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return CONTENT_TYPES.get(name.slice(dot).toLowerCase());
}
