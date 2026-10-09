/** The packages a site author installs, by directory under `packages/` (#690). */
export const PUBLIC_PACKAGES = [
  "adapter-cloudflare-pages",
  "adapter-cloudflare-worker",
  "adapter-cloudfront",
  "adapter-netlify",
  "adapter-nginx",
  "adapter-vercel",
  "content",
  "core",
  "create-pagedeck",
  "docs",
  "edge",
  "font-subset",
  "islands",
  "markdown-loader",
  "preview",
  "search",
  "social-image",
] as const;

export const PUBLIC_VERSION = "0.2.3";

/**
 * What a package may pack besides `dist`, `package.json`, `README*` and
 * `LICENSE`: nothing, except for `create-pagedeck`, the `template/` files its
 * `files` names one by one (#691, #731). A directory named there admits nothing
 * under it.
 */
export function packedBesideDist(manifest: {
  name: string;
  files?: readonly string[];
}): ReadonlySet<string> {
  if (manifest.name !== "create-pagedeck") return new Set();
  return new Set((manifest.files ?? []).filter((file) => file.startsWith("template/")));
}

export const DOCS_PACKAGE = "@pagedeck/docs";

export const DOCS_PREPACK = "node src/assemble.ts";

/**
 * `@pagedeck/docs` emits no code: it packs its pages, `nav.json` and `assets/`
 * in place of `dist` (#108).
 */
export function packedAsDocs(manifest: { name: string }, entry: string): boolean {
  return manifest.name === DOCS_PACKAGE && /^(nav\.json|assets\/.+|.+\.md)$/.test(entry);
}
