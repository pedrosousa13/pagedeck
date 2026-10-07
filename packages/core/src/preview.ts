import { ConfigError } from "./exit.js";
import { localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { collisionLines } from "./manifest.js";
import type { EmittedFile, FileKind } from "./manifest.js";
import { quote } from "./quote.js";

export interface PreviewSetting {
  readonly path: string;
  readonly bridge?: string;
}

const SHAPE_FIX = 'preview: { path: "/_preview" }';
const PATH_FIX =
  'write the address the CMS loads the app from, starting at the root and with no trailing slash, such as path: "/_preview"';
const BRIDGE_FIX =
  'point bridge at a module that default-exports a PreviewBridge, such as bridge: "./src/preview-bridge.ts"';

const SEPARATOR = /\s/;

export function previewFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.preview" must be an object naming where the preview app is emitted — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const faults: string[] = [];
  const path = Object.hasOwn(record, "path") ? record["path"] : undefined;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    SEPARATOR.test(path)
  ) {
    faults.push(
      `  "path" — ${quote(path)} — not a root-relative path to emit the preview app at — ${PATH_FIX}`,
    );
  }
  const bridge = Object.hasOwn(record, "bridge") ? record["bridge"] : undefined;
  if (bridge !== undefined && (typeof bridge !== "string" || bridge === "")) {
    faults.push(
      `  "bridge" — ${quote(bridge)} — not a module specifier — ${BRIDGE_FIX}`,
    );
  }
  if (faults.length === 0) return undefined;
  return `${where}: "build.preview" declares ${String(faults.length)} ${
    faults.length === 1 ? "field" : "fields"
  } this build cannot emit a preview app from — declare each as the type its own line names:\n${faults.join("\n")}`;
}

export interface PreviewOutput {
  fileName: string;
  kind: FileKind;
  hashed?: true;
  contents: string | Uint8Array;
}

export interface PreviewBundle {
  entry: string;
  files: readonly PreviewOutput[];
}

export interface PreviewInput {
  setting: PreviewSetting;
  bundle: PreviewBundle;
  locales: LocaleSet;
  emitted: readonly EmittedFile[];
}

export function previewPath(path: string, fileName: string): string {
  return `${path}/${fileName}`;
}

const DOCUMENT = "index.html";

export function previewFiles(input: PreviewInput): readonly EmittedFile[] {
  // `""`, not `undefined`: `sort` moves `undefined` last without calling the
  // comparator.
  const trees = new Set<string>();
  for (const locale of input.locales.values()) {
    trees.add(localeTree(locale) ?? "");
  }
  const domains = [...trees].sort();

  const base = input.setting.path;
  const inTree = [
    {
      path: previewPath(base, DOCUMENT),
      kind: "html" as FileKind,
      contents: previewDocument(previewPath(base, input.bundle.entry)),
    },
    ...input.bundle.files.map((file) => ({
      path: previewPath(base, file.fileName),
      kind: file.kind,
      ...(file.hashed === true ? { hashed: true as const } : {}),
      contents: file.contents,
    })),
  ];

  const files: EmittedFile[] = domains.flatMap((domain) =>
    inTree.map((file) => ({
      ...(domain === "" ? {} : { domain }),
      ...file,
    })),
  );

  const collisions = collisionLines(files, input.emitted);
  if (collisions.length > 0) {
    throw new ConfigError(
      `Preview: ${String(collisions.length)} ${
        collisions.length === 1 ? "file is" : "files are"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the preview app is; move the page off that address, or declare a "build.preview.path" the site does not publish under:\n${collisions.join("\n")}`,
    );
  }
  return files;
}

export function previewDocument(script: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    "<title>Preview</title>",
    "</head>",
    "<body>",
    // Not imported from `@pagedeck/preview`: `@pagedeck/core` must not depend on it (spec
    // §14).
    '<div id="fw-preview"></div>',
    `<script type="module" src="${script}"></script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
