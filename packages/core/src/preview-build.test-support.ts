// Not `buildPreview`: this externalizes React and runs outside `inProductionEnv`, two
// things the production build must not do.
import { runBundle } from "./bundler.js";
import { previewInput, servePreviewEntry } from "./entry-modules.js";
import { checkPreviewGraph } from "./preview-graph.js";
import type { PreviewEntry } from "./preview-entry.js";

export interface BuiltChunk {
  fileName: string;
  name: string;
  code: string;
  // By resolved id: Rolldown writes a module path into a chunk only as a comment relative
  // to `build.root`, so searching `chunk.code` for it can never match.
  moduleIds: readonly string[];
}

export interface PreviewBuildInput {
  root: string;
  origin: string;
  entry: PreviewEntry;
  external: readonly string[];
}

export async function previewBuild(
  input: PreviewBuildInput,
): Promise<BuiltChunk[]> {
  const result = await runBundle({
    config: {
      configFile: false,
      logLevel: "warn",
      root: input.root,
      build: {
        write: false,
        minify: false,
        outDir: "dist/preview",
        rolldownOptions: {
          input: previewInput(input.entry),
          external: [...input.external],
        },
      },
    },
    plugins: [servePreviewEntry(input.entry, input.origin)],
  });

  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((one) =>
    "output" in one
      ? one.output
          .filter((emitted) => emitted.type === "chunk")
          .map((chunk) => ({
            fileName: chunk.fileName,
            name: chunk.name,
            code: chunk.code,
            moduleIds: Object.keys(chunk.modules),
          }))
      : [],
  );

  checkPreviewGraph(chunks);
  return chunks;
}
