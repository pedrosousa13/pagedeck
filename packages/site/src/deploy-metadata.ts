import type { FileKind } from "@pagedeck/core";

export interface ObjectMetadata {
  contentType: string;
  cacheControl: string;
}

export const UNKNOWN_TYPE = "application/octet-stream";

export const IMMUTABLE = "public, max-age=31536000, immutable";

export const REVALIDATE = "no-cache";

const HTML = "text/html; charset=utf-8";
const JAVASCRIPT = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const PLAIN = "text/plain; charset=utf-8";

const BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".html", HTML],
  [".js", JAVASCRIPT],
  [".css", CSS],
  [".json", "application/json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".txt", PLAIN],
  [".woff2", "font/woff2"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".deployed-at", PLAIN],
]);

const BY_NAME: ReadonlyMap<string, string> = new Map([
  ["_headers", PLAIN],
  ["_redirects", PLAIN],
]);

const BY_KIND: Readonly<Record<Exclude<FileKind, "asset">, string>> = {
  html: HTML,
  js: JAVASCRIPT,
  css: CSS,
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function typeOfName(path: string): string {
  const name = baseName(path);
  const named = BY_NAME.get(name);
  if (named !== undefined) return named;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return UNKNOWN_TYPE;
  return BY_EXTENSION.get(name.slice(dot).toLowerCase()) ?? UNKNOWN_TYPE;
}

// A page revalidates even on a `hashed` row: a retraction has to reach it (#555).
export function fileMetadata(file: {
  path: string;
  kind: FileKind;
  hashed?: true;
}): ObjectMetadata {
  const contentType = file.kind === "asset" ? typeOfName(file.path) : BY_KIND[file.kind];
  return {
    contentType,
    cacheControl: file.kind !== "html" && file.hashed === true ? IMMUTABLE : REVALIDATE,
  };
}

export function documentMetadata(key: string): ObjectMetadata {
  return { contentType: typeOfName(key), cacheControl: REVALIDATE };
}
