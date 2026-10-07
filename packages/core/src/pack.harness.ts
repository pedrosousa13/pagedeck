import { execFile, spawn as spawnProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  packedBesideDist,
  PUBLIC_PACKAGES,
  PUBLIC_VERSION,
} from "./public-packages.test-support.js";
import { fences, TUTORIAL } from "../../docs/src/tutorial.test-support.js";

const run = promisify(execFile);

const REPO = join(import.meta.dirname, "..", "..", "..");

const ALLOWED = /^(package\.json|README[^/]*|LICENSE|dist\/.+)$/;
const NOT_EMITTED_FOR_CONSUMERS = /^dist\/(\.tsbuildinfo$|.*\.(test|harness|test-support)\.|.*\.map$)/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface Manifest {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
}

interface Packed {
  tarball: string;
  manifest: Manifest;
  entries: string[];
}

// The variables `pnpm test:pack-harness` itself exports would configure the
// install below with this workspace's settings.
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(npm_|pnpm_config_)/i.test(key)),
  );
}

async function spawn(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return run(command, args, { cwd, env: cleanEnv(), maxBuffer: 64 * 1024 * 1024 }).catch(
    (cause: { stdout?: string; stderr?: string }) => {
      throw new Error(
        `Command "${command} ${args.join(" ")}" in "${cwd}": failed — its output is below and the error is attached as the cause\n${cause.stdout ?? ""}\n${cause.stderr ?? ""}`,
        { cause },
      );
    },
  );
}

function outside(path: string): boolean {
  const from = relative(REPO, path);
  return from.startsWith(`..${sep}`) || from === "..";
}

function workspaceAbove(path: string): string | undefined {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

let root = "";
const packed: Packed[] = [];

async function install(
  dir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const overrides = Object.fromEntries(
    packed.map(({ manifest: packedManifest, tarball }) => [
      packedManifest.name,
      `file:${tarball}`,
    ]),
  );
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // JSON is YAML. `esbuild` is allowed its build script here as the workspace allows it.
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    `${JSON.stringify({ overrides, allowBuilds: { esbuild: true }, hoist: false }, null, 2)}\n`,
  );
  // Without it, a range resolves to the newest version in pnpm's metadata cache,
  // not the version this workspace locked.
  await copyFile(join(REPO, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"));
  // Unfrozen: the copy only seeds resolution. Not offline: a fresh runner's cache lacks
  // metadata for entries outside its own install (#14).
  await spawn("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], dir);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pagedeck-pack-harness-"));
  if (!outside(root)) {
    throw new Error(
      `Pack harness: its temporary directory "${root}" is inside this repository at "${REPO}", so an install there would link workspace packages — point TMPDIR outside the repository`,
    );
  }
  const above = workspaceAbove(root);
  if (above !== undefined) {
    throw new Error(
      `Pack harness: its temporary directory "${root}" is under the pnpm workspace at "${above}", so an install there would join that workspace — point TMPDIR somewhere with no pnpm-workspace.yaml above it`,
    );
  }
  const tarballs = join(root, "tarballs");
  await mkdir(tarballs);
  for (const dir of PUBLIC_PACKAGES) {
    await spawn("pnpm", ["pack", "--pack-destination", tarballs], join(REPO, "packages", dir));
  }
  for (const file of (await readdir(tarballs)).filter((name) => name.endsWith(".tgz")).sort()) {
    const tarball = join(tarballs, file);
    const manifest = JSON.parse(
      (await spawn("tar", ["-xzOf", tarball, "package/package.json"], root)).stdout,
    ) as Manifest;
    const entries = (await spawn("tar", ["-tzf", tarball], root)).stdout
      .split("\n")
      .filter((line) => line !== "" && !line.endsWith("/"))
      .map((line) => line.replace(/^package\//, ""));
    packed.push({ tarball, manifest, entries });
  }
}, 600_000);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

test("every public package packs one tarball", () => {
  expect(packed.map(({ manifest }) => manifest.name).sort()).toEqual(
    PUBLIC_PACKAGES.map(
      (dir) =>
        (
          JSON.parse(readFileSync(join(REPO, "packages", dir, "package.json"), "utf8")) as Manifest
        ).name,
    ).sort(),
  );
});

test("every tarball holds its manifest, readme, licence and emitted dist, and nothing else", () => {
  const faults: string[] = [];
  for (const { manifest, entries } of packed) {
    const stowaways = entries.filter(
      (entry) =>
        (!ALLOWED.test(entry) && !packedBesideDist(manifest).has(entry)) ||
        NOT_EMITTED_FOR_CONSUMERS.test(entry),
    );
    if (stowaways.length > 0) {
      faults.push(
        `Package "${manifest.name}": its tarball carries ${String(stowaways.length)} file(s) outside package.json, README*, LICENSE, dist and, for create-pagedeck alone, the template/ files its "files" names one by one, or a build cache, test, harness or source map inside dist — ${stowaways.join(", ")} — narrow its "files", or keep the file out of the emitted dist in its tsconfig.build.json`,
      );
    }
    if (!entries.includes("LICENSE")) {
      faults.push(`Package "${manifest.name}": its tarball has no LICENSE — add one to the package directory`);
    }
    if (!entries.includes("README.md")) {
      faults.push(`Package "${manifest.name}": its tarball has no README.md — add one to the package directory`);
    }
  }
  expect(faults).toEqual([]);
});

test("no packed file names this repository's path", async () => {
  const faults: string[] = [];
  for (const { tarball, manifest } of packed) {
    const into = join(root, "unpacked", manifest.name);
    await mkdir(into, { recursive: true });
    await spawn("tar", ["-xzf", tarball, "-C", into], root);
    const files = await readdir(into, { recursive: true, withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile())) {
      const path = join(file.parentPath, file.name);
      if ((await readFile(path, "utf8")).includes(REPO)) {
        faults.push(
          `Package "${manifest.name}": ${relative(into, path)} names "${REPO}", a path that exists only on the machine that packed it — emit without it`,
        );
      }
    }
  }
  expect(faults).toEqual([]);
}, 60_000);

function exportTargets(value: unknown, where: string): { where: string; target: string }[] {
  if (typeof value === "string") return [{ where, target: value }];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    exportTargets(inner, `${where} → "${key}"`),
  );
}

test("every target a packed manifest exports is a file in its tarball", () => {
  const faults: string[] = [];
  for (const { manifest, entries } of packed) {
    for (const { where, target } of exportTargets(manifest.exports, "exports")) {
      const path = target.replace(/^\.\//, "");
      const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
      if (!entries.some((entry) => new RegExp(`^${escaped}$`).test(entry))) {
        faults.push(
          `Package "${manifest.name}": ${where} points at "${target}", which its tarball does not hold — a resolver that reads this condition fails; drop the condition from the packed manifest in .pnpmfile.mjs, or pack the file`,
        );
      }
    }
  }
  expect(faults).toEqual([]);
});

test("every packed manifest is 0.1.0 and depends on no private or unversioned package", () => {
  const privateNames = new Set(
    readdirSync(join(REPO, "packages"))
      .map((dir) => join(REPO, "packages", dir, "package.json"))
      .filter((path) => existsSync(path))
      .map((path) => JSON.parse(readFileSync(path, "utf8")) as { name: string; private?: boolean })
      .filter((found) => found.private === true)
      .map((found) => found.name),
  );
  expect(privateNames.size).toBeGreaterThan(0);
  const faults: string[] = [];
  for (const { manifest } of packed) {
    const text = JSON.stringify(manifest);
    if (manifest.version !== PUBLIC_VERSION) {
      faults.push(`Package "${manifest.name}": packed at version "${manifest.version}" — set "version": "${PUBLIC_VERSION}"`);
    }
    if (text.includes("workspace:")) {
      faults.push(
        `Package "${manifest.name}": its packed manifest still says "workspace:" — pack with pnpm, which rewrites the protocol to the version`,
      );
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (privateNames.has(name) || range === "0.0.0") {
          faults.push(
            `Package "${manifest.name}": ${field}."${name}" is packed as "${range}", a package no registry will hold — drop the field from the packed manifest in .pnpmfile.mjs, or depend on a public package`,
          );
        } else if (name.startsWith("@pagedeck/") && range !== PUBLIC_VERSION) {
          faults.push(
            `Package "${manifest.name}": ${field}."${name}" is packed as "${range}" — a consumer cannot install it; depend only on public packages, each at "${PUBLIC_VERSION}"`,
          );
        }
      }
    }
  }
  expect(faults).toEqual([]);
});

test("every subpath of every public package imports in an install outside the workspace", async () => {
  const dir = join(root, "imports");
  await mkdir(dir);
  await install(dir, {
    name: "pagedeck-imports",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      packed.map(({ manifest }) => [manifest.name, PUBLIC_VERSION]),
    ),
  });
  const specifiers = packed.flatMap(({ manifest }) =>
    Object.keys(manifest.exports ?? {})
      .filter((subpath) => !subpath.includes("*"))
      .map((subpath) => manifest.name + subpath.slice(1)),
  );
  expect(specifiers.length).toBeGreaterThanOrEqual(PUBLIC_PACKAGES.length);
  const script = `const failures = [];
for (const specifier of ${JSON.stringify(specifiers)}) {
  try { await import(specifier); } catch (cause) { failures.push(specifier + ": " + String(cause).split("\\n")[0]); }
}
console.log(JSON.stringify(failures));`;
  await writeFile(join(dir, "imports.mjs"), script);
  const { stdout } = await spawn(process.execPath, ["imports.mjs"], dir);
  expect(JSON.parse(stdout.trim().split("\n").at(-1) as string)).toEqual([]);
}, 600_000);

async function installCreatePagedeck(dir: string): Promise<string> {
  await mkdir(dir);
  await install(dir, {
    name: "pagedeck-create",
    private: true,
    dependencies: { "create-pagedeck": PUBLIC_VERSION },
  });
  return join(dir, "node_modules", ".bin", "create-pagedeck");
}

interface DevServer {
  origin: string;
  stop(): void;
}

// `--port 0`, so a server already on the default port cannot fail the run.
async function startDev(bin: string, args: readonly string[], cwd: string): Promise<DevServer> {
  const child = spawnProcess(bin, [...args, "--port", "0"], { cwd, env: cleanEnv() });
  let output = "";
  const origin = await new Promise<string>((resolve, reject) => {
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      const served = / at (http:\/\/\S+)/.exec(output);
      if (served !== null) resolve(served[1] as string);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(
        new Error(
          `Command "${bin} ${args.join(" ")}" in "${cwd}": exited with code ${String(code)} before it served a page — its output is below\n${output}`,
        ),
      );
    });
  });
  return { origin, stop: () => child.kill() };
}

function routeOf(page: string): string {
  const path = page.slice("content/".length, -".md".length).replace(/(^|\/)index$/, "");
  return `/${path}`;
}

test("following the tutorial with create-pagedeck's tarball reaches a built site", async () => {
  const create = await installCreatePagedeck(join(root, "tutorial-create"));
  let cwd = join(root, "tutorial");
  await mkdir(cwd);
  let dev: DevServer | undefined;
  let watching = false;
  const added: string[] = [];
  const pagedeck = (): string => join(cwd, "node_modules", ".bin", "pagedeck");
  const stop = (): void => {
    dev?.stop();
    dev = undefined;
    watching = false;
  };

  const follow = async (line: string): Promise<void> => {
    const [command, ...args] = line.trim().split(/\s+/);
    if (command === "cd" && args.length === 1) {
      cwd = join(cwd, args[0] as string);
      return;
    }
    if (command === "npm" && args[0] === "create" && /^pagedeck(@latest)?$/.test(args[1] ?? "")) {
      await spawn(create, args.slice(2), cwd);
      return;
    }
    if (command === "npm" && args.length === 1 && args[0] === "install") {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      await install(cwd, manifest);
      return;
    }
    if (command === "npx" && args[0] === "pagedeck" && args[1] === "dev") {
      dev = await startDev(pagedeck(), args.slice(1), cwd);
      expect((await fetch(new URL("/", dev.origin))).status, "/ from pagedeck dev").toBe(200);
      return;
    }
    if (
      command === "npx" &&
      args[0] === "pagedeck" &&
      args[1] === "sync" &&
      args.includes("--watch")
    ) {
      watching = true;
      await spawn(pagedeck(), ["sync"], cwd);
      return;
    }
    if (command === "npx" && args[0] === "pagedeck") {
      // The page has the reader stop `pagedeck dev` and `pagedeck sync --watch` before
      // building.
      if (args[1] === "build") stop();
      await spawn(pagedeck(), args.slice(1), cwd);
      return;
    }
    throw new Error(
      `Tutorial "packages/docs/content/tutorials/your-first-site.md": the harness cannot follow the shell line "${line}" — it runs npm create pagedeck, cd, npm install and npx pagedeck lines; follow the new command here, or write the step without it`,
    );
  };

  try {
    for (const { lang, code, file } of fences(await readFile(TUTORIAL, "utf8"))) {
      if (lang === "sh") {
        for (const line of code.split("\n").filter((found) => found.trim() !== "")) {
          await follow(line);
        }
        continue;
      }
      if (file === undefined) {
        throw new Error(
          `Tutorial "packages/docs/content/tutorials/your-first-site.md": a ${lang === "" ? "plain" : lang} fence starting "${code.split("\n")[0] ?? ""}" names no file, so the harness cannot tell where to write it — end the line before it with the file's path in backticks and a colon`,
        );
      }
      const path = join(cwd, file);
      if (existsSync(path)) {
        expect(code, `${file} as the tutorial quotes it`).toBe(await readFile(path, "utf8"));
        continue;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, code);
      added.push(file);
      if (watching) await spawn(pagedeck(), ["sync"], cwd);
      if (dev !== undefined && /^content\/.+\.md$/.test(file)) {
        const route = routeOf(file);
        expect((await fetch(new URL(route, dev.origin))).status, `${route} from pagedeck dev`).toBe(
          200,
        );
      }
    }
  } finally {
    stop();
  }

  expect(added.length, "the tutorial adds a page").toBeGreaterThan(0);
  const pages = (await readdir(join(cwd, "content"), { recursive: true }))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `content/${file.split(sep).join("/")}`);
  expect(pages).toEqual(expect.arrayContaining(added));
  const unbuilt = pages.filter(
    (page) => !existsSync(join(cwd, "site", routeOf(page), "index.html")),
  );
  expect(unbuilt).toEqual([]);
}, 600_000);

interface BudgetRow {
  path: string;
  actual: number;
  chunks: { path: string; bytes: number }[];
}

test("the site create-pagedeck writes builds from installed packages, and only its island page ships JavaScript", async () => {
  const create = await installCreatePagedeck(join(root, "create"));
  await spawn(create, ["my-site"], root);

  const site = join(root, "my-site");
  expect(existsSync(join(site, ".gitignore"))).toBe(true);
  const manifest = JSON.parse(await readFile(join(site, "package.json"), "utf8")) as Manifest;
  expect(
    Object.entries(manifest.dependencies ?? {}).filter(
      ([name, range]) => name.startsWith("@pagedeck/") && range !== PUBLIC_VERSION,
    ),
  ).toEqual([]);
  await install(site, manifest as unknown as Record<string, unknown>);

  const bin = join(site, "node_modules", ".bin", "pagedeck");
  await spawn(bin, ["sync"], site);
  await spawn(bin, ["build"], site);

  // The template declares no budget, and a build writes no budget report without one.
  const config = join(site, "pagedeck.config.ts");
  const unbudgeted = await readFile(config, "utf8");
  const budgeted = unbudgeted.replace(
    "  build: {",
    '  build: {\n    budget: { "/**": "1mb" },',
  );
  expect(budgeted, `pagedeck.config.ts has no build section to add a budget to`).not.toBe(
    unbudgeted,
  );
  await writeFile(config, budgeted);
  await spawn(bin, ["build"], site);

  const report = JSON.parse(
    await readFile(join(site, ".pagedeck", "budget-report.json"), "utf8"),
  ) as { pages: BudgetRow[] };
  const content = report.pages.filter(({ path }) => path !== "/counter/");
  expect(content.map(({ path }) => path).sort()).toEqual(["/", "/about/"]);
  expect(content.map(({ path, actual }) => ({ path, actual }))).toEqual(
    content.map(({ path }) => ({ path, actual: 0 })),
  );

  const island = report.pages.find(({ path }) => path === "/counter/");
  const counter = (island?.chunks ?? []).filter(({ path }) =>
    readFileSync(join(site, "site", path), "utf8").includes("Clicked "),
  );
  expect(counter).toHaveLength(1);
}, 600_000);
