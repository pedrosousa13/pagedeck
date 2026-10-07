#!/usr/bin/env node
import { ArgumentError, create } from "./index.js";

try {
  process.stdout.write(`${await create(process.argv.slice(2), process.cwd())}\n`);
} catch (error) {
  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  process.stderr.write(`${messages.length > 0 ? messages.join(": ") : String(error)}\n`);
  process.exitCode = error instanceof ArgumentError ? 2 : 1;
}
