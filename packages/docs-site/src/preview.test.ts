import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { fences } from "./tutorial.test-support.js";

const REFERENCE = join(import.meta.dirname, "..", "..", "docs", "reference", "preview.md");
const DOCS = join(import.meta.dirname, "..");
const BASE_CONFIG = join(DOCS, "..", "..", "tsconfig.base.json");
// Its fence is held to the producer in `packages/core/src/cli.ts` by `catalogued-messages.test.ts`.
const CATALOGUE = join(DOCS, "..", "..", "docs", "error-messages.md");

const BRIDGE = "src/preview-bridge.ts";

function markdown(): string {
  expect(existsSync(REFERENCE), REFERENCE).toBe(true);
  return readFileSync(REFERENCE, "utf8");
}

const notice = (markdown: string): string | undefined =>
  fences(markdown).find(({ code }) => code.startsWith("preview: "))?.code;

test("the build notice the page quotes is the one the catalogue holds to the CLI", () => {
  const catalogued = notice(readFileSync(CATALOGUE, "utf8"));
  expect(catalogued, `a preview: line fenced in ${CATALOGUE}`).toBeDefined();
  expect(notice(markdown())).toBe(catalogued);
});

test("the build notice the page quotes cites this page's title and one of its headings", () => {
  const text = markdown();
  const cited = /\(Pagedeck documentation: ([^,]+), ([^)]+)\)\n$/.exec(notice(text) ?? "");
  expect(cited, `a quoted preview: line ending "(Pagedeck documentation: <title>, <heading>)"`).not.toBeNull();
  expect(/^title: (.+)$/m.exec(text)?.[1]).toBe(cited?.[1]);
  expect(text.split("\n")).toContain(`## ${String(cited?.[2])}`);
});

test("the bridge sample compiles against the real PreviewBridge", () => {
  const samples = fences(markdown()).filter(({ file }) => file === BRIDGE);
  expect(samples).toHaveLength(1);
  expect(samples[0]?.code).toContain('from "@pagedeck/preview"');
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    (JSON.parse(readFileSync(BASE_CONFIG, "utf8")) as { compilerOptions: object }).compilerOptions,
    DOCS,
  );
  expect(errors).toEqual([]);
  const lib = [...(options.lib ?? []), "lib.dom.d.ts"];
  // Inside the docs package, so `@pagedeck/preview` resolves as a site's would.
  const name = join(DOCS, BRIDGE);
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (path) => path === name || fileExists(path);
  host.readFile = (path) => (path === name ? samples[0]?.code : readFile(path));
  host.getSourceFile = (path, language, ...rest) =>
    path === name
      ? ts.createSourceFile(path, samples[0]?.code ?? "", language)
      : getSourceFile(path, language, ...rest);
  const program = ts.createProgram({ rootNames: [name], options: { ...options, lib, noEmit: true }, host });
  const faults = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(faults).toEqual([]);
}, 60_000);
