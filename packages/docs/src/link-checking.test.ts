import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { LinkProbe } from "@pagedeck/core";
import { fences } from "./tutorial.test-support.js";

const DOCS = join(import.meta.dirname, "..");
const REFERENCE = join(DOCS, "reference", "link-checking.md");
const BASE_CONFIG = join(DOCS, "..", "..", "tsconfig.base.json");

const PROBE = "src/probe.ts";

const REFUSED = [
  "http://169.254.169.254/latest/meta-data/",
  "http://localhost/",
  "http://localhost.:8080/",
  "http://admin.localhost/",
  "http://0.0.0.0/",
  "http://127.0.0.1/",
  "http://2130706433/",
  "http://0x7f.1/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://[::1]/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
  "http://[fe80::1]/",
  "http://[febf::1]/",
];

const ASKED = [
  "https://example.com/",
  "http://172.32.0.1/",
  "http://11.0.0.1/",
  "http://127.example.com/",
  "http://[2001:db8::1]/",
];

function sample(): string {
  const samples = fences(readFileSync(REFERENCE, "utf8")).filter(({ file }) => file === PROBE);
  expect(samples).toHaveLength(1);
  return samples[0]?.code ?? "";
}

const scratch = mkdtempSync(join(tmpdir(), "pagedeck-link-probe-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadProbe(): Promise<LinkProbe> {
  const { outputText } = ts.transpileModule(sample(), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = join(scratch, "probe.mjs");
  writeFileSync(file, outputText);
  const loaded = (await import(`${pathToFileURL(file).href}?${String(Date.now())}`)) as {
    probe: LinkProbe;
  };
  return loaded.probe;
}

test("the probe sample compiles against the real LinkProbe", () => {
  const code = sample();
  expect(code).toContain('from "@pagedeck/core"');
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    (JSON.parse(readFileSync(BASE_CONFIG, "utf8")) as { compilerOptions: object }).compilerOptions,
    DOCS,
  );
  expect(errors).toEqual([]);
  const lib = [...(options.lib ?? []), "lib.dom.d.ts"];
  // Inside the docs package, so `@pagedeck/core` resolves as a site's would.
  const name = join(DOCS, PROBE);
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (path) => path === name || fileExists(path);
  host.readFile = (path) => (path === name ? code : readFile(path));
  host.getSourceFile = (path, language, ...rest) =>
    path === name ? ts.createSourceFile(path, code, language) : getSourceFile(path, language, ...rest);
  const program = ts.createProgram({ rootNames: [name], options: { ...options, lib, noEmit: true }, host });
  const faults = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(faults).toEqual([]);
}, 60_000);

test("the probe sample throws on an internal host without making a request", async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
  vi.stubGlobal("fetch", fetch);
  const probe = await loadProbe();
  for (const url of REFUSED) {
    await expect(probe(url), url).rejects.toThrow(Error);
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('the probe sample asks a public host once, with redirect: "manual", and answers its status', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 301 })));
  vi.stubGlobal("fetch", fetch);
  const probe = await loadProbe();
  for (const url of ASKED) {
    await expect(probe(url), url).resolves.toBe(301);
  }
  expect(fetch.mock.calls).toEqual(
    ASKED.map((url) => [url, expect.objectContaining({ method: "HEAD", redirect: "manual" })]),
  );
});
