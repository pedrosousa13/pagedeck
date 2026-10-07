#!/usr/bin/env node
import { runCli } from "./cli.js";
import { markDiagnostic } from "./diagnostic-marker.js";
import { installJsxLoader } from "./jsx-loader.js";

installJsxLoader();

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  // Marked only here, where our stderr mixes with other tools' output (#184).
  err: (line) => process.stderr.write(`${markDiagnostic(line)}\n`),
});

process.exit(code);
