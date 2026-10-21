import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, test, vi } from "vitest";
import { fences } from "./tutorial.test-support.js";
import type { Fence } from "./tutorial.test-support.js";

// The page's crash is a dead compiler process, which no module provokes reliably (#164).
const forked = vi.hoisted((): ChildProcess[] => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fork = ((...args: Parameters<typeof actual.fork>) => {
    const child = actual.fork(...args);
    forked.push(child);
    return child;
  }) as typeof actual.fork;
  return { ...actual, fork };
});
import { compileIslands, MODULE_TIME_LIMIT_MS } from "@pagedeck/core/react-compiler";

const REFERENCE = join(import.meta.dirname, "..", "..", "docs", "reference", "react-compiler.md");
const ROOT = "/home/you/my-site";

function markdown(): string {
  expect(existsSync(REFERENCE), REFERENCE).toBe(true);
  return readFileSync(REFERENCE, "utf8");
}

const isOutput = (fence: Fence | undefined, path = ""): fence is Fence =>
  fence !== undefined && fence.file === undefined && fence.code.startsWith(`pagedeck: Module "${path}`);

const unmarked = (fence: Fence): string => fence.code.trimEnd().replace(/^pagedeck: /gm, "");

// What compileIslands writes for one module: each warning, or a fatal's message before
// the throw. `during` runs once the module is with the compiler's process.
async function compiled(path: string, code: string, during?: () => void): Promise<string[]> {
  const lines: string[] = [];
  const { configResolved, buildStart, transform, buildEnd } = compileIslands({
    err: (line) => lines.push(line),
  }).plugin;
  if (
    typeof configResolved !== "function" ||
    typeof buildStart !== "function" ||
    typeof transform !== "function" ||
    typeof buildEnd !== "function"
  ) {
    throw new Error("compileIslands no longer has plain hooks");
  }
  const context = {} as never;
  configResolved.call(context, { root: ROOT } as never);
  buildStart.call(context, {} as never);
  const pending = Promise.resolve(transform.call(context, code, path, undefined));
  during?.();
  await pending.catch(() => undefined);
  buildEnd.call(context, undefined);
  return lines;
}

test("each module the page shows prints exactly the output quoted after it, or nothing", async () => {
  const all = fences(markdown());
  const shown = all.flatMap((fence, at) => {
    if (fence.file === undefined) return [];
    const path = `${ROOT}/${fence.file}`;
    return [{ fence, path, output: isOutput(all[at + 1], `${path}"`) ? all[at + 1] : undefined }];
  });
  expect(shown.filter(({ output }) => output !== undefined).length).toBeGreaterThanOrEqual(2);
  expect(shown.some(({ fence, output }) => fence.code.includes('"use no memo"') && output === undefined)).toBe(
    true,
  );
  for (const { fence, path, output } of shown) {
    const lines = await compiled(path, fence.code);
    expect(lines.join("\n"), `${String(fence.file)}:\n${fence.code}`).toBe(
      output === undefined ? "" : unmarked(output),
    );
  }
}, 60_000);

test("the crash the page quotes is what a compiler process dying on SIGSEGV prints", async () => {
  const all = fences(markdown());
  const crash = all.find((fence) => isOutput(fence) && fence.code.includes("React Compiler crashed"));
  expect(crash, "a quoted crash warning").toBeDefined();
  const path = /^pagedeck: Module "([^"]+)"/.exec(crash?.code ?? "")?.[1];
  expect(path?.startsWith(`${ROOT}/`), `the crash names a module under ${ROOT}`).toBe(true);
  const source = all.find(({ file }) => file !== undefined)?.code ?? "";

  const lines = await compiled(String(path), source, () => forked.at(-1)?.kill("SIGSEGV"));

  expect(lines.join("\n")).toBe(unmarked(crash as Fence));
}, 60_000);

test("the time limit the page states is MODULE_TIME_LIMIT_MS", () => {
  const stated = [...markdown().matchAll(/`ran past (\d+) s`|longer than (\d+) seconds/g)].map((match) =>
    Number(match[1] ?? match[2]),
  );
  expect(stated).toHaveLength(2);
  expect(stated).toEqual([MODULE_TIME_LIMIT_MS / 1000, MODULE_TIME_LIMIT_MS / 1000]);
});
