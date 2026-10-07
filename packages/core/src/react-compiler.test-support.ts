import type { PluginOption } from "vite";
import { runBundle } from "./bundler.js";
import { inProductionEnv } from "./client-build.js";

// `inProductionEnv` from `client-build.ts`: `mode` alone leaves `NODE_ENV` as
// Vitest's `test`, which builds with the JSX dev transform (#107).
export async function clientBuild(
  root: string,
  entries: readonly string[],
  plugins: readonly PluginOption[],
): Promise<{ code: string; warnings: string[] }> {
  const warnings: string[] = [];
  const result = await inProductionEnv(async () =>
    runBundle({
      config: {
        configFile: false,
        envDir: false,
        logLevel: "warn",
        mode: "production",
        define: { "process.env.NODE_ENV": '"production"' },
        oxc: { jsx: { runtime: "automatic", development: false } },
        root,
        customLogger: {
          info() {},
          warn(message) {
            warnings.push(message);
          },
          warnOnce(message) {
            warnings.push(message);
          },
          error() {},
          clearScreen() {},
          hasErrorLogged() {
            return false;
          },
          hasWarned: false,
        },
        build: {
          outDir: `${root}dist/`,
          write: false,
          minify: false,
          rollupOptions: {
            input: [...entries],
            external: [/^react(\/|$)/],
            output: { format: "esm" },
            // A boundary is loaded and rendered by the islands runtime rather than
            // run for its side effects, so its exports have to survive.
            preserveEntrySignatures: "strict",
          },
        },
      },
      // Through `sitePlugins`, unguarded: these suites measure what their plugin does, and
      // a guard catching a hook's throw would change it.
      plugins: [],
      sitePlugins: plugins,
    }),
  );
  const outputs = Array.isArray(result) ? result : [result];
  const code = outputs
    .flatMap((one) => ("output" in one ? one.output : []))
    .filter((emitted) => emitted.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");
  return { code, warnings };
}

// The bundler renames the compiler's `_c` alias, so the import is what to count.
export const MEMO_CACHE_IMPORT = /\bfrom ["']react\/compiler-runtime["']/g;
export const MEMO_CACHE_INIT = /const \$ = \w+\(\d+\);/g;
