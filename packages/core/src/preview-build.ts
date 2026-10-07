import type { PluginOption } from "vite";
import { runBundle } from "./bundler.js";
import { ASSET_DIR, assetKind, contentNaming, inProductionEnv } from "./client-build.js";
import { previewInput, servePreviewEntry } from "./entry-modules.js";
import type { PreviewEntry } from "./preview-entry.js";
import { checkPreviewGraph } from "./preview-graph.js";
import type { PreviewBundle, PreviewOutput } from "./preview.js";

export interface PreviewBuildInput {
  root: string;
  origin: string;
  path: string;
  entry: PreviewEntry;
  plugins?: readonly PluginOption[];
}

export async function buildPreview(
  input: PreviewBuildInput,
): Promise<PreviewBundle> {
  const naming = contentNaming();
  const result = await inProductionEnv(async () =>
    runBundle({
      config: {
        configFile: false,
        envDir: false,
        logLevel: "warn",
        mode: "production",
        define: { "process.env.NODE_ENV": '"production"' },
        oxc: { jsx: { runtime: "automatic", development: false } },
        root: input.root,
        base: `${input.path}/`,
        build: {
          write: false,
          assetsDir: ASSET_DIR,
          rolldownOptions: {
            input: previewInput(input.entry),
            output: {
              entryFileNames: `${ASSET_DIR}/[name]-[hash].js`,
              chunkFileNames: `${ASSET_DIR}/[name]-[hash].js`,
              assetFileNames: naming.assetFileNames,
            },
          },
        },
      },
      plugins: [servePreviewEntry(input.entry, input.origin)],
      sitePlugins: input.plugins,
    }),
  );

  const files: PreviewOutput[] = [];
  const chunks: { fileName: string; moduleIds: readonly string[] }[] = [];
  let entry: string | undefined;

  const outputs = Array.isArray(result) ? result : [result];
  for (const one of outputs) {
    if (!("output" in one)) continue;
    for (const emitted of one.output) {
      if (emitted.type === "chunk") {
        files.push({
          fileName: emitted.fileName,
          kind: "js",
          ...(naming.hashed(emitted) ? { hashed: true as const } : {}),
          contents: emitted.code,
        });
        chunks.push({
          fileName: emitted.fileName,
          moduleIds: Object.keys(emitted.modules),
        });
        if (emitted.isEntry) entry = emitted.fileName;
      } else {
        files.push({
          fileName: emitted.fileName,
          kind: assetKind(emitted.fileName),
          ...(naming.hashed(emitted) ? { hashed: true as const } : {}),
          contents: emitted.source,
        });
      }
    }
  }

  checkPreviewGraph(chunks);

  if (entry === undefined) {
    throw new Error(
      "Preview target: the bundler emitted no entry chunk, so there is no app for the preview document to load — this is a framework fault, not a site one; report it against @pagedeck/core",
    );
  }
  return { entry, files };
}
