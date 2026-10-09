import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { EXAMPLE, HOW_TO, REPORT } from "./connect-a-cms.test-support.js";
import { fences } from "./tutorial.test-support.js";

const BASE_CONFIG = join(import.meta.dirname, "..", "..", "..", "tsconfig.base.json");

// The one file the page has the reader write that the example does not hold, since the
// example's CMS takes no token. It is compiled rather than quoted.
const WRITTEN = "src/token.ts";

const indent = (line: string): number => line.length - line.trimStart().length;

// The fence's lines, in order and next to each other, with every line moved by one indent:
// an excerpt from inside a function may drop the function's indentation.
function quotes(source: string, code: string): boolean {
  const wanted = code.trimEnd().split("\n");
  const lines = source.split("\n");
  const first = wanted[0] as string;
  return lines.some((_, start) => {
    const shift = indent(lines[start] as string) - indent(first);
    if (shift < 0) return false;
    return wanted.every((line, offset) => {
      const real = lines[start + offset];
      if (real === undefined) return false;
      return line.trim() === "" ? real.trim() === "" : real === " ".repeat(shift) + line;
    });
  });
}

function page(): ReturnType<typeof fences> {
  expect(existsSync(HOW_TO), HOW_TO).toBe(true);
  return fences(readFileSync(HOW_TO, "utf8"));
}

test("every code sample names the example file it quotes, and is a run of that file's lines", () => {
  let quoted = 0;
  for (const { code, file } of page()) {
    expect(file, `a fence whose lead names the example file it quotes:\n${code}`).toBeDefined();
    if (file === REPORT || file === WRITTEN) continue;
    const path = join(EXAMPLE, file as string);
    expect(existsSync(path), `${file}, in packages/cms-example`).toBe(true);
    expect(quotes(readFileSync(path, "utf8"), code), `${file} holds these lines, in order:\n${code}`).toBe(
      true,
    );
    quoted += 1;
  }
  expect(quoted).toBeGreaterThan(0);
});

test("the token sample compiles as a file of the example", () => {
  const samples = page().filter(({ file }) => file === WRITTEN);
  expect(samples).toHaveLength(1);
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    (JSON.parse(readFileSync(BASE_CONFIG, "utf8")) as { compilerOptions: object }).compilerOptions,
    EXAMPLE,
  );
  expect(errors).toEqual([]);
  const name = join(EXAMPLE, WRITTEN);
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (path) => path === name || fileExists(path);
  host.readFile = (path) => (path === name ? samples[0]?.code : readFile(path));
  host.getSourceFile = (path, language, ...rest) =>
    path === name
      ? ts.createSourceFile(path, samples[0]?.code ?? "", language)
      : getSourceFile(path, language, ...rest);
  const program = ts.createProgram({ rootNames: [name], options: { ...options, noEmit: true }, host });
  const faults = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(faults).toEqual([]);
}, 60_000);

test("the token sample fetches with redirect: \"manual\", so read still sees and refuses a redirect", () => {
  const samples = page().filter(({ file }) => file === WRITTEN);
  expect(samples).toHaveLength(1);
  expect(samples[0]?.code).toContain('redirect: "manual"');
});
