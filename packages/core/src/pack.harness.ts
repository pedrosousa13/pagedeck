import { execFile, spawn as spawnProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  copyFile,
  cp,
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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  packedAsDocs,
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
// install below with this workspace's settings, and the `NODE_PATH` pnpm's bin
// shims export would let a `require` find this workspace's packages. The OIDC
// request pair would let anything the harness spawns mint a token, should a job
// ever grant one (#58).
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(npm_|pnpm_config_|NODE_PATH$|ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)$)/i.test(key)),
    ),
    WRANGLER_SEND_METRICS: "false",
  };
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
  // JSON is YAML. `esbuild` and `workerd` get the build-script decision the workspace gives them.
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    `${JSON.stringify({ overrides, allowBuilds: { esbuild: true, workerd: false }, hoist: false }, null, 2)}\n`,
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
        (!ALLOWED.test(entry) && !packedBesideDist(manifest).has(entry) && !packedAsDocs(manifest, entry)) ||
        NOT_EMITTED_FOR_CONSUMERS.test(entry),
    );
    if (stowaways.length > 0) {
      faults.push(
        `Package "${manifest.name}": its tarball carries ${String(stowaways.length)} file(s) outside package.json, README*, LICENSE, dist, for create-pagedeck alone the template/ and template-app/ files its "files" names one by one, and for @pagedeck/docs alone its markdown, nav.json and assets/, or a build cache, test, harness or source map inside dist — ${stowaways.join(", ")} — narrow its "files", or keep the file out of the emitted dist in its tsconfig.build.json`,
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

test("every packed manifest is PUBLIC_VERSION and depends on no private or unversioned package", () => {
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
      // npm passes what follows `--` to the initializer, and drops the `--` itself.
      const passed = args.slice(2);
      const separator = passed.indexOf("--");
      if (separator !== -1) passed.splice(separator, 1);
      await spawn(create, passed, cwd);
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
      `Tutorial "packages/docs/tutorials/your-first-site.md": the harness cannot follow the shell line "${line}" — it runs npm create pagedeck, cd, npm install and npx pagedeck lines; follow the new command here, or write the step without it`,
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
          `Tutorial "packages/docs/tutorials/your-first-site.md": a ${lang === "" ? "plain" : lang} fence starting "${code.split("\n")[0] ?? ""}" names no file, so the harness cannot tell where to write it — end the line before it with the file's path in backticks and a colon`,
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
  const built = await spawn(bin, ["build"], site);
  expect(built.stderr, "the first build's stderr").not.toContain("Security headers");

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

test("the site create-pagedeck --app writes installs Hono from npm, builds with the /api/ upstream, and ships none of the app", async () => {
  const create = await installCreatePagedeck(join(root, "create-app"));
  await spawn(create, ["app-site", "--app"], root);

  const site = join(root, "app-site");
  const manifest = JSON.parse(await readFile(join(site, "package.json"), "utf8")) as Manifest;
  expect(Object.keys(manifest.dependencies ?? {})).toEqual(
    expect.arrayContaining(["hono", "@hono/node-server"]),
  );
  await install(site, manifest as unknown as Record<string, unknown>);

  const bin = join(site, "node_modules", ".bin", "pagedeck");
  await spawn(bin, ["sync"], site);
  await spawn(bin, ["build"], site);

  const built = JSON.parse(await readFile(join(site, "site", "manifest.json"), "utf8")) as {
    routing: { trees: { upstreams?: { prefix: string }[] }[] };
  };
  expect(built.routing.trees.map((tree) => tree.upstreams)).toEqual([[{ prefix: "/api/" }]]);

  const app = await readFile(join(site, "app", "index.ts"), "utf8");
  const unique = ["The app answered.", "no-store"];
  for (const marker of unique) expect(app).toContain(marker);
  const assets = join(site, "site", "assets");
  const chunks = await Promise.all(
    (await readdir(assets))
      .filter((file) => file.endsWith(".js"))
      .map(async (file) => ({ file, code: await readFile(join(assets, file), "utf8") })),
  );
  expect(
    chunks.filter(({ file, code }) => file.startsWith("hello-") && code.includes("$get")),
  ).toHaveLength(1);
  expect(
    chunks.flatMap(({ file, code }) =>
      unique.filter((marker) => code.includes(marker)).map((marker) => `${file}: ${marker}`),
    ),
  ).toEqual([]);
}, 600_000);

// The files `packages/app-example`'s README builds from, and the dev dependencies that build
// and its release run: the others are its tests'.
const APP_EXAMPLE_FILES = [
  "pagedeck.config.ts",
  "wrangler.jsonc",
  "favicon.ico",
  "content",
  "public",
  "src/app.ts",
  "src/csp.ts",
  "src/components",
  "src/release.ts",
];
const APP_EXAMPLE_TOOLS = ["react-dom", "wrangler"];

test("the app example, copied out of the repository, builds from installed packages and prepares a release wrangler would upload", async () => {
  const example = join(REPO, "packages", "app-example");
  const site = join(root, "app-example");
  for (const path of APP_EXAMPLE_FILES) {
    await cp(join(example, path), join(site, path), { recursive: true });
  }
  const own = JSON.parse(await readFile(join(example, "package.json"), "utf8")) as Manifest;
  const pinned = Object.fromEntries(
    Object.entries(own.dependencies ?? {}).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? PUBLIC_VERSION : range,
    ]),
  );
  const missing = APP_EXAMPLE_TOOLS.filter((name) => own.devDependencies?.[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Package "${own.name}": its devDependencies lack ${missing.map((name) => `"${name}"`).join(", ")}, which its build and release run — declare each at the version the example uses, or take it out of APP_EXAMPLE_TOOLS in pack.harness.ts`,
    );
  }
  const tools = Object.fromEntries(
    APP_EXAMPLE_TOOLS.map((name) => [name, own.devDependencies?.[name] ?? ""]),
  );
  await install(site, {
    name: "app-example",
    private: true,
    type: "module",
    dependencies: pinned,
    devDependencies: tools,
  });

  const bin = join(site, "node_modules", ".bin", "pagedeck");
  await spawn(bin, ["sync"], site);
  await spawn(bin, ["build"], site);
  const prepared = await spawn(process.execPath, ["src/release.ts", "prepare"], site);

  const releases = join(site, "releases");
  const [id, ...others] = await readdir(releases);
  expect(others).toEqual([]);
  const built = JSON.parse(await readFile(join(site, "site", "manifest.json"), "utf8")) as {
    build: { id: string };
  };
  expect(id).toBe(built.build.id);
  const release = join(releases, id as string);
  expect(prepared.stdout).toContain(`Release "${built.build.id}" written to "${release}"`);
  const record = JSON.parse(await readFile(join(release, "release.json"), "utf8")) as {
    worker: string;
    wrangler: string;
  };
  expect(record.wrangler).toBe(tools.wrangler);

  const upload = await spawn(
    join(site, "node_modules", ".bin", "wrangler"),
    ["deploy", "--dry-run", record.worker, "--no-bundle"],
    release,
  );
  expect(`${upload.stdout}${upload.stderr}`).toContain("--dry-run: exiting now.");
}, 600_000);

interface HostCase {
  readonly host: "vercel" | "cloudflare-pages" | "netlify";
  readonly dependency: string;
  readonly files: readonly string[];
}

const HOST_CASES: readonly HostCase[] = [
  { host: "vercel", dependency: "@pagedeck/adapter-vercel", files: ["vercel.json"] },
  {
    host: "cloudflare-pages",
    dependency: "@pagedeck/adapter-cloudflare-pages",
    files: ["_redirects", "_headers"],
  },
  {
    host: "netlify",
    dependency: "@pagedeck/adapter-netlify",
    files: ["_redirects", "_headers"],
  },
];

describe("a site created with --host", () => {
  let hostsRoot = "";

  // One shared install for all three scaffolded sites — a workspace over them — so dependency
  // resolution and download happen once rather than three times.
  beforeAll(async () => {
    const create = await installCreatePagedeck(join(root, "create-hosts"));
    hostsRoot = join(root, "hosts");
    await mkdir(hostsRoot);
    for (const { host } of HOST_CASES) {
      await spawn(create, [`site-${host}`, "--host", host], hostsRoot);
    }
    await writeFile(
      join(hostsRoot, "package.json"),
      `${JSON.stringify({ name: "pagedeck-hosts", private: true }, null, 2)}\n`,
    );
    const overrides = Object.fromEntries(
      packed.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
    );
    await writeFile(
      join(hostsRoot, "pnpm-workspace.yaml"),
      `${JSON.stringify(
        {
          packages: HOST_CASES.map(({ host }) => `site-${host}`),
          overrides,
          allowBuilds: { esbuild: true },
          hoist: false,
        },
        null,
        2,
      )}\n`,
    );
    await copyFile(join(REPO, "pnpm-lock.yaml"), join(hostsRoot, "pnpm-lock.yaml"));
    await spawn("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], hostsRoot);
  }, 600_000);

  for (const { host, dependency, files } of HOST_CASES) {
    test(`--host ${host} depends on ${dependency} and writes ${files.join(", ")}`, async () => {
      const site = join(hostsRoot, `site-${host}`);
      const manifest = JSON.parse(await readFile(join(site, "package.json"), "utf8")) as Manifest;
      expect(manifest.dependencies?.[dependency]).toBe(PUBLIC_VERSION);

      const bin = join(site, "node_modules", ".bin", "pagedeck");
      await spawn(bin, ["sync"], site);
      const built = await spawn(bin, ["build"], site);
      expect(built.stderr, "the first build's stderr").not.toContain("Security headers");

      for (const file of files) {
        expect(existsSync(join(site, "site", file)), `site/${file}`).toBe(true);
      }
    }, 600_000);
  }
});
