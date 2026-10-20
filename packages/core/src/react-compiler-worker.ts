import { transformSync } from "oxc-transform-react";
import type { SourceMap } from "oxc-transform-react";

export type Lang = "jsx" | "ts" | "tsx";

export interface CompileRequest {
  filename: string;
  code: string;
  lang: Lang;
}

export interface Diagnostic {
  message: string;
  help: string | null;
  /** A UTF-8 byte offset into the source, as Oxc reports it. */
  byteStart: number | undefined;
}

export interface CompileReply {
  fatal: boolean;
  code: string;
  map: SourceMap | undefined;
  diagnostics: Diagnostic[];
}

process.on("message", (request: CompileRequest) => {
  const result = transformSync(request.filename, request.code, {
    lang: request.lang,
    sourcemap: true,
    // Vite's own transform takes the JSX.
    jsx: "preserve",
    reactCompiler: {
      target: "19",
      // The default skips `node_modules`, where a design system's islands live.
      sources: [""],
      reportDiagnostics: true,
    },
  });
  const reply: CompileReply = {
    fatal: result.fatal,
    code: result.code,
    map: result.map,
    diagnostics: result.errors.map((error) => ({
      message: error.message,
      help: error.helpMessage,
      byteStart: error.labels[0]?.start,
    })),
  };
  process.send?.(reply);
});

process.on("disconnect", () => {
  process.exit(0);
});
