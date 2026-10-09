import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import ts from "typescript";
import { afterAll, expect, test } from "vitest";
import { runCli } from "@pagedeck/core";
import { fences } from "./tutorial.test-support.js";

const HOW_TO = join(import.meta.dirname, "..", "..", "docs", "how-to", "deploy-a-site.md");
const DOCS = join(import.meta.dirname, "..");
const BASE_CONFIG = join(DOCS, "..", "..", "tsconfig.base.json");
const ADAPTER_NETLIFY_PACKAGE = join(DOCS, "..", "adapter-netlify", "package.json");

// Empty, so every verb stops at loading the config: nothing is built, synced or sent.
const NOWHERE = mkdtempSync(join(tmpdir(), "pagedeck-deploy-how-to-"));

afterAll(() => {
  rmSync(NOWHERE, { recursive: true, force: true });
});

function markdown(): string {
  expect(existsSync(HOW_TO), HOW_TO).toBe(true);
  return readFileSync(HOW_TO, "utf8");
}

// A command ends where the shell takes over: a comment, a redirect, a pipe or a second command.
function command(line: string): string[] | undefined {
  const found = /(?:^|[\s:])(?:npx\s+)?pagedeck\s+(\S.*)$/.exec(line);
  if (found === null) return undefined;
  const words = (found[1] as string).split(/\s+(?:#|>|\||&&|;)/)[0] as string;
  return words.trim().split(/\s+/);
}

function fencedCommands(text: string): string[][] {
  const commands: string[][] = [];
  for (const { code } of fences(text)) {
    for (const line of code.split("\n")) {
      const args = command(line);
      if (args !== undefined) commands.push(args);
    }
  }
  return commands;
}

function mentionedCommands(text: string): string[][] {
  return [...prose(text).matchAll(/`((?:npx\s+)?pagedeck\s[^`\n]+)`/g)].map(
    (span) => command(span[1] as string) as string[],
  );
}

function prose(text: string): string {
  return text.replace(/^```\S*\n[\s\S]*?^```$/gm, "");
}

async function cli(args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const lines: string[] = [];
  await runCli(args, {
    cwd: NOWHERE,
    env,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return lines.join("\n");
}

// `pagedeck` has no --help: it answers it as an unknown command, with the usage text.
async function help(): Promise<string> {
  const text = await cli(["--help"]);
  expect(text).toContain("Usage:");
  return text;
}

// An inline mention may leave out the verb's arguments, so only an unknown option or command is
// its fault; a sample must parse whole, and every usage error carries the usage text.
async function faultsOf(commands: readonly string[][], whole = true): Promise<string[]> {
  const usage = await help();
  const faults: string[] = [];
  for (const args of commands) {
    const shown = `pagedeck ${args.join(" ")}`;
    const [verb, subcommand] = args;
    const named = verb === "store" ? `pagedeck store ${String(subcommand)}` : `pagedeck ${String(verb)}`;
    if (!usage.includes(named)) faults.push(`${shown}: --help names no ${named}`);
    for (const flag of args.filter((arg) => arg.startsWith("--"))) {
      if (!usage.includes(flag)) faults.push(`${shown}: --help names no ${flag}`);
    }
    // `store` with no <url> reads the variable, as the page's CI sample sets it.
    const env: Record<string, string> =
      verb === "store" && args.length === 2 ? { PAGEDECK_SNAPSHOT_URL: "file:///nowhere/content.db" } : {};
    const output = await cli(args, env);
    const fault = whole
      ? output.includes("Usage:") && output.split("\n")[0]
      : output.split("\n").find((line) => /^Unknown (?:option|command) /.test(line));
    if (typeof fault === "string") faults.push(`${shown}: ${fault}`);
  }
  return faults;
}

test("the check refuses a flag, a verb and a subcommand the CLI does not have", async () => {
  const faults = await faultsOf([["build", "--made-up"], ["deploy", "site"], ["store", "sync"]]);
  expect(faults).toEqual([
    "pagedeck build --made-up: --help names no --made-up",
    'pagedeck build --made-up: Unknown option "--made-up" for pagedeck build.',
    "pagedeck deploy site: --help names no pagedeck deploy",
    'pagedeck deploy site: Unknown command "deploy".',
    "pagedeck store sync: --help names no pagedeck store sync",
    'pagedeck store sync: Unknown command "pagedeck store sync".',
  ]);
});

test("every pagedeck command in a sample is one the CLI takes, flags included", async () => {
  const commands = fencedCommands(markdown());
  expect(commands.length).toBeGreaterThan(5);
  expect(await faultsOf(commands)).toEqual([]);
});

const inlineFaults = async (text: string): Promise<string[]> => faultsOf(mentionedCommands(text), false);

test("the inline check refuses a flag its verb does not take, though another verb does", async () => {
  expect(await inlineFaults("It takes no `pagedeck rollback --force`.")).toEqual([
    'pagedeck rollback --force: Unknown option "--force" for pagedeck rollback.',
  ]);
});

test("every pagedeck verb and flag the prose names is in the CLI's help", async () => {
  expect(mentionedCommands(markdown()).length).toBeGreaterThan(5);
  expect(await inlineFaults(markdown())).toEqual([]);
});

test("every flag the page names on its own is in the CLI's help", async () => {
  const usage = await help();
  const flags = [...prose(markdown()).matchAll(/`(--[\w-]+)/g)].map((match) => match[1] as string);
  expect(flags.length).toBeGreaterThan(0);
  expect(flags.filter((flag) => !usage.includes(flag))).toEqual([]);
});

test("every edge sample compiles in a site", () => {
  const samples = fences(markdown()).filter(({ lang }) => lang === "ts");
  expect(samples).toHaveLength(2);
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    (JSON.parse(readFileSync(BASE_CONFIG, "utf8")) as { compilerOptions: object }).compilerOptions,
    DOCS,
  );
  expect(errors).toEqual([]);
  for (const [index, sample] of samples.entries()) {
    // Inside the docs package, so `@pagedeck/core` and the adapter resolve as a site's would.
    const name = join(DOCS, sample.file ?? `compile-edge-${String(index)}.ts`);
    const host = ts.createCompilerHost(options);
    const { fileExists, getSourceFile, readFile } = host;
    host.fileExists = (path) => path === name || fileExists(path);
    host.readFile = (path) => (path === name ? sample.code : readFile(path));
    host.getSourceFile = (path, language, ...rest) =>
      path === name
        ? ts.createSourceFile(path, sample.code, language)
        : getSourceFile(path, language, ...rest);
    const program = ts.createProgram({ rootNames: [name], options: { ...options, noEmit: true }, host });
    const faults = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(faults).toEqual([]);
  }
}, 60_000);

test("the netlify.toml sample parses and names a Node version the adapter's engines accept", () => {
  const samples = fences(markdown()).filter(({ lang }) => lang === "toml");
  expect(samples).toHaveLength(1);
  const parsed = parseToml(samples[0]?.code as string) as {
    build: {
      command: string;
      publish: string;
      environment: { NODE_VERSION: string };
      processing: { html: { pretty_urls: boolean } };
    };
  };
  expect(parsed.build.command).toContain("npx pagedeck sync");
  expect(parsed.build.command).toContain("npx pagedeck build");
  expect(parsed.build.publish).toBe("site");
  expect(parsed.build.processing.html.pretty_urls).toBe(false);

  // The sample names a concrete version; the lowest `engines.node` this repo asks of a site
  // naming it (`^22.18.0`'s own floor) so a reader who pins it is never under the adapter's
  // own floor.
  const engines = (
    JSON.parse(readFileSync(ADAPTER_NETLIFY_PACKAGE, "utf8")) as { engines: { node: string } }
  ).engines.node;
  expect(engines).toContain(parsed.build.environment.NODE_VERSION);
});
