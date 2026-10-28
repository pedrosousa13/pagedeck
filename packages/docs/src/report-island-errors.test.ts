import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { fences } from "./tutorial.test-support.js";

const DOCS = join(import.meta.dirname, "..");
const GUIDE = join(DOCS, "how-to", "report-island-errors.md");
const BASE_CONFIG = join(DOCS, "..", "..", "tsconfig.base.json");

const REPORTER = "src/report-island-errors.ts";

test("the reporter sample compiles against the real IslandErrorReport", () => {
  const samples = fences(readFileSync(GUIDE, "utf8")).filter(
    ({ file }) => file === REPORTER,
  );
  expect(samples).toHaveLength(1);
  const code = samples[0]?.code ?? "";
  expect(code).toContain('from "@pagedeck/core"');
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    (JSON.parse(readFileSync(BASE_CONFIG, "utf8")) as { compilerOptions: object })
      .compilerOptions,
    DOCS,
  );
  expect(errors).toEqual([]);
  const lib = [...(options.lib ?? []), "lib.dom.d.ts"];
  // Inside the docs package, so `@pagedeck/core` resolves as a site's would.
  const name = join(DOCS, REPORTER);
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (path) => path === name || fileExists(path);
  host.readFile = (path) => (path === name ? code : readFile(path));
  host.getSourceFile = (path, language, ...rest) =>
    path === name
      ? ts.createSourceFile(path, code, language)
      : getSourceFile(path, language, ...rest);
  const program = ts.createProgram({
    rootNames: [name],
    options: { ...options, lib, noEmit: true },
    host,
  });
  const faults = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(faults).toEqual([]);
}, 60_000);
