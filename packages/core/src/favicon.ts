import { ConfigError } from "./exit.js";
import { localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { collisionLines } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import { quote } from "./quote.js";

export interface FaviconSetting {
  readonly src: string;
}

const SHAPE_FIX = 'favicon: { src: "./favicon.ico" }';
const SRC_FIX =
  'point src at the file this build writes at /favicon.ico, such as src: "./favicon.ico"';

export function faviconFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.favicon" must be an object naming the icon file the site supplies — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const src = Object.hasOwn(record, "src") ? record["src"] : undefined;
  const faults: string[] = [];
  if (typeof src !== "string" || src === "") {
    faults.push(
      `  "src" — ${quote(src)} — not a path to the site's icon file — ${SRC_FIX}`,
    );
  }
  if (faults.length === 0) return undefined;
  return `${where}: "build.favicon" declares ${String(faults.length)} ${
    faults.length === 1 ? "field" : "fields"
  } this build cannot write an icon from — declare each as the type its own line names:\n${faults.join("\n")}`;
}

const FAVICON_PATH = "/favicon.ico";

export function absentFaviconWarning(
  declared: boolean,
  emitted: readonly EmittedFile[],
): string | undefined {
  if (declared || emitted.some((file) => file.path === FAVICON_PATH)) {
    return undefined;
  }
  return `Favicon: this site declares no build.favicon, so no output tree has a file at /favicon.ico — a browser requests that address on its own, whether or not a page links to it, and the 404 it gets is logged as a console error and fails Lighthouse's errors-in-console audit; this is a warning and not a refusal because every page this build emitted is correct — set build.favicon to the site's icon file, as ${SHAPE_FIX} (Pagedeck documentation: Favicon)`;
}

export interface FaviconInput {
  bytes: Uint8Array;
  locales: LocaleSet;
  emitted: readonly EmittedFile[];
}

export function faviconFiles(input: FaviconInput): readonly EmittedFile[] {
  // `""`, not `undefined`: `sort` moves `undefined` to the end without calling
  // the comparator, and `""` sorts first.
  const trees = new Set<string>();
  for (const locale of input.locales.values()) {
    trees.add(localeTree(locale) ?? "");
  }
  const domains = [...trees].sort();

  const files: EmittedFile[] = domains.map((domain) => ({
    ...(domain === "" ? {} : { domain }),
    path: FAVICON_PATH,
    kind: "asset",
    contents: input.bytes,
  }));

  const collisions = collisionLines(files, input.emitted);
  if (collisions.length > 0) {
    throw new ConfigError(
      `Favicon: ${String(collisions.length)} ${
        collisions.length === 1 ? "icon is" : "icons are"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the icon is; move the page off that address:\n${collisions.join("\n")}`,
    );
  }
  return files;
}
