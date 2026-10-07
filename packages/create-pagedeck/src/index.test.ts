import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ArgumentError, create } from "./index.js";
import type { CreateIO } from "./index.js";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
const PACKAGES = join(PACKAGE, "..");
const BIN = join(PACKAGE, "dist", "bin.js");

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "create-pagedeck-"));
});

afterEach(() => {
  chmodSync(cwd, 0o700);
  for (const entry of readdirSync(cwd)) chmodSync(join(cwd, entry), 0o700);
  rmSync(cwd, { recursive: true, force: true });
});

async function failure(args: string[], io?: CreateIO): Promise<Error> {
  try {
    await create(args, cwd, io);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`create(${JSON.stringify(args)}) wrote a site where a failure was expected`);
}

async function refusal(args: string[], io?: CreateIO): Promise<string> {
  const error = await failure(args, io);
  expect(error).toBeInstanceOf(ArgumentError);
  return error.message;
}

function lockedDirectory(): string {
  const locked = join(cwd, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  return locked;
}

function listedTemplate(): string[] {
  const { files } = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
    files: string[];
  };
  return files.flatMap((file) =>
    file.startsWith("template/") ? [file.slice("template/".length)] : [],
  );
}

// A fake terminal: an injected stream pair with `isTTY` set, since node:readline needs no real
// TTY to read lines from. Each queued answer is written as soon as a prompt reaches `stdout`, so
// the two questions `create` asks (directory, then host) each get the line meant for it.
function tty(answers: readonly string[]): { io: CreateIO; prompts: () => string } {
  const stdin = new PassThrough() as unknown as CreateIO["stdin"] & PassThrough;
  const stdout = new PassThrough() as unknown as CreateIO["stdout"] & PassThrough;
  Object.assign(stdin, { isTTY: true });
  Object.assign(stdout, { isTTY: true });
  let next = 0;
  let prompts = "";
  stdout.on("data", (chunk: Buffer) => {
    prompts += chunk.toString();
    const answer = answers[next++];
    if (answer !== undefined) stdin.write(`${answer}\n`);
  });
  return { io: { stdin, stdout }, prompts: () => prompts };
}

// A non-TTY pair, standing in for a pipe, a redirect, or the pack harness: `isTTY` is left
// `undefined`, as a real piped stream's is.
function notTTY(): CreateIO {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

test("package.json lists the template file by file", () => {
  expect(listedTemplate()).toContain("pagedeck.config.ts");
});

test("the template directory holds the listed files and nothing else", () => {
  const listed = listedTemplate();
  const onDisk = filesUnder(join(PACKAGE, "template"));

  expect(
    onDisk.filter((file) => !listed.includes(file)),
    'files in template/ that package.json\'s "files" does not list, so they would never be packed or written; list them or delete them',
  ).toEqual([]);
  expect(listed.filter((file) => !onDisk.includes(file)), "listed files missing from template/").toEqual([]);
});

test("writes exactly the listed template files, with _gitignore written as .gitignore, plus a package.json", async () => {
  await create(["my-site"], cwd, notTTY());

  const template = listedTemplate().map((file) => (file === "_gitignore" ? ".gitignore" : file));
  expect(filesUnder(join(cwd, "my-site"))).toEqual([...template, "package.json"].sort());
});

test("the written .gitignore names the store, the output directory, the build records and node_modules", async () => {
  await create(["my-site"], cwd, notTTY());

  const ignored = readFileSync(join(cwd, "my-site", ".gitignore"), "utf8").split("\n");
  expect(ignored).toEqual(
    expect.arrayContaining(["node_modules/", "content.db", "site/", ".pagedeck/"]),
  );
});

test("the package.json is named after the directory and depends on @pagedeck/* at create-pagedeck's own version", async () => {
  await create([join("sites", "my-site")], cwd, notTTY());

  const own = manifestOf(PACKAGE);
  const core = manifestOf(join(PACKAGES, "core"));
  expect(JSON.parse(readFileSync(join(cwd, "sites", "my-site", "package.json"), "utf8"))).toEqual({
    name: "my-site",
    private: true,
    type: "module",
    dependencies: {
      "@pagedeck/content": own.version,
      "@pagedeck/core": own.version,
      "@pagedeck/islands": own.version,
      "@pagedeck/markdown-loader": own.version,
      react: core.dependencies?.react,
      "react-dom": core.dependencies?.["react-dom"],
    },
    devDependencies: {
      "@types/react": core.devDependencies?.["@types/react"],
    },
  });
});

test("the React ranges a site is given are the ones the public packages and the workspace declare", async () => {
  await create(["my-site"], cwd, notTTY());

  const site = manifestOf(join(cwd, "my-site"));
  for (const dir of ["core", "islands"]) {
    const declared = manifestOf(join(PACKAGES, dir));
    expect({
      dir,
      react: site.dependencies?.react,
      "react-dom": site.dependencies?.["react-dom"],
      "@types/react": site.devDependencies?.["@types/react"],
    }).toEqual({
      dir,
      react: declared.dependencies?.react,
      "react-dom": declared.dependencies?.["react-dom"],
      "@types/react": declared.devDependencies?.["@types/react"],
    });
  }
  expect(site.devDependencies?.["@types/react"]).toBe(
    manifestOf(PACKAGE).devDependencies?.["@types/react"],
  );
});

test("writes into a directory that exists and is empty", async () => {
  mkdirSync(join(cwd, "my-site"));

  await create(["my-site"], cwd, notTTY());

  expect(existsSync(join(cwd, "my-site", "pagedeck.config.ts"))).toBe(true);
});

test("prints the next steps, starting from the directory as given", async () => {
  expect(await create(["my-site"], cwd, notTTY())).toBe(
    [
      `Created "my-site" in ${join(cwd, "my-site")}. Next:`,
      "",
      "  cd my-site",
      "  npm install",
      "  npx pagedeck sync",
      "  npx pagedeck dev",
    ].join("\n"),
  );
});

test("refuses a directory that holds files, naming them, and writes nothing", async () => {
  const target = join(cwd, "my-site");
  mkdirSync(target);
  writeFileSync(join(target, "notes.txt"), "keep me\n");

  expect(await refusal(["my-site"], notTTY())).toBe(
    `Directory "${target}": already holds 1 entry (notes.txt) — pass a directory that does not exist yet or is empty; create-pagedeck never writes over files`,
  );
  expect(filesUnder(target)).toEqual(["notes.txt"]);
});

test("refuses a path that is a file, and leaves it as it was", async () => {
  writeFileSync(join(cwd, "my-site"), "keep me\n");

  expect(await refusal(["my-site"], notTTY())).toBe(
    `Directory "${join(cwd, "my-site")}": is a file, not a directory — pass a directory that does not exist yet or is empty; create-pagedeck never writes over files`,
  );
  expect(readFileSync(join(cwd, "my-site"), "utf8")).toBe("keep me\n");
});

test("refuses a directory whose name is not a valid package name, suggests one, and writes nothing", async () => {
  expect(await refusal(["My Site"], notTTY())).toBe(
    `Directory "${join(cwd, "My Site")}": the site's package.json takes its name from the directory, and "My Site" is not a valid npm package name — pass a name of at most 214 lowercase letters, digits, "-", "." and "_" that starts with a letter or digit, such as "my-site"`,
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses a name longer than npm allows", async () => {
  const name = "a".repeat(215);

  expect(await refusal([name], notTTY())).toContain(
    `is not a valid npm package name — pass a name of at most 214 lowercase letters, digits, "-", "." and "_" that starts with a letter or digit, such as "${"a".repeat(214)}"`,
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses a call with no directory, off a terminal", async () => {
  expect(await refusal([], notTTY())).toBe(
    "Arguments: no directory given — pass the directory to create the site in, as in npm create pagedeck@latest my-site",
  );
});

test("refuses more than one directory, and writes nothing", async () => {
  expect(await refusal(["one", "two"], notTTY())).toBe(
    'Arguments: 2 directories given ("one", "two") — pass one, as in npm create pagedeck@latest my-site',
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses an option it does not take, and writes nothing", async () => {
  expect(await refusal(["my-site", "--template", "blog"], notTTY())).toBe(
    'Arguments: create-pagedeck takes no options besides --host, --yes and --help, and was given "--template" — pass only the directory and those options, as in npm create pagedeck@latest my-site',
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses several options by naming every one", async () => {
  expect(await refusal(["my-site", "--template", "blog", "-x", "--force"], notTTY())).toBe(
    'Arguments: create-pagedeck takes no options besides --host, --yes and --help, and was given 3: "--template", "-x", "--force" — pass only the directory and those options, as in npm create pagedeck@latest my-site',
  );
});

test("a directory it cannot write fails naming the directory and a fix, with Node's error as the cause", async () => {
  const target = join(lockedDirectory(), "my-site");

  const error = await failure([join("locked", "my-site")], notTTY());

  expect(error).not.toBeInstanceOf(ArgumentError);
  expect(error.message).toBe(
    `Directory "${target}": could not write the site — check that you can write there and the disk has room, delete anything written so far, and run create-pagedeck again`,
  );
  expect((error.cause as NodeJS.ErrnoException).code).toBe("EACCES");
});

test("--help prints usage naming --host, --yes and --help, and writes nothing", async () => {
  const usage = await create(["--help"], cwd, notTTY());

  expect(usage).toContain("Usage: create-pagedeck");
  expect(usage).toContain("--host");
  expect(usage).toContain("--yes");
  expect(usage).toContain("--help");
  expect(readdirSync(cwd)).toEqual([]);
});

test("--help wins over an argument that would otherwise be refused", async () => {
  const usage = await create(["My Site", "--help"], cwd, notTTY());

  expect(usage).toContain("Usage:");
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses an unsupported host, and writes nothing", async () => {
  expect(await refusal(["my-site", "--host", "fastly"], notTTY())).toBe(
    'Arguments: --host "fastly" is not supported — use one of: vercel, cloudflare-pages, netlify, none',
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses --host given with no value", async () => {
  expect(await refusal(["my-site", "--host"], notTTY())).toBe(
    "Arguments: --host given with no value — use one of: vercel, cloudflare-pages, netlify, none",
  );
});

test("--host none writes the same site as no --host at all", async () => {
  await create(["one"], cwd, notTTY());
  await create(["two", "--host", "none"], cwd, notTTY());

  expect(filesUnder(join(cwd, "two"))).toEqual(filesUnder(join(cwd, "one")));
  for (const file of filesUnder(join(cwd, "one")).filter((found) => found !== "package.json")) {
    expect(readFileSync(join(cwd, "two", file), "utf8"), file).toBe(
      readFileSync(join(cwd, "one", file), "utf8"),
    );
  }
  const { name: oneName, ...oneRest } = manifestOf(join(cwd, "one")) as unknown as Record<
    string,
    unknown
  >;
  const { name: twoName, ...twoRest } = manifestOf(join(cwd, "two")) as unknown as Record<
    string,
    unknown
  >;
  expect([oneName, twoName]).toEqual(["one", "two"]);
  expect(twoRest).toEqual(oneRest);
});

for (const [host, dependency, factory, importPath] of [
  ["vercel", "@pagedeck/adapter-vercel", "vercel", "@pagedeck/adapter-vercel"],
  [
    "cloudflare-pages",
    "@pagedeck/adapter-cloudflare-pages",
    "cloudflarePages",
    "@pagedeck/adapter-cloudflare-pages",
  ],
  ["netlify", "@pagedeck/adapter-netlify", "netlify", "@pagedeck/adapter-netlify"],
] as const) {
  test(`--host ${host} depends on ${dependency} and names it in pagedeck.config.ts's build.adapter`, async () => {
    await create(["my-site", "--host", host], cwd, notTTY());

    const own = manifestOf(PACKAGE);
    const manifest = manifestOf(join(cwd, "my-site"));
    expect(manifest.dependencies?.[dependency]).toBe(own.version);

    const config = readFileSync(join(cwd, "my-site", "pagedeck.config.ts"), "utf8");
    expect(config).toContain(`import { ${factory} } from "${importPath}";`);
    expect(config).toContain(`adapter: ${factory}(),`);
  });

  test(`--host ${host} appends that host's deploy steps to README.md`, async () => {
    await create(["my-site", "--host", host], cwd, notTTY());

    const readme = readFileSync(join(cwd, "my-site", "README.md"), "utf8");
    expect(readme).toContain("npx pagedeck sync && npx pagedeck build");
    expect(readme).toContain("site");
    expect(readme).toMatch(/deploy-a-site\.md/);
  });

  test(`--host ${host} names the host in the closing message`, async () => {
    const message = await create(["my-site", "--host", host], cwd, notTTY());
    expect(message).toContain("set up for");
    expect(message.toLowerCase()).toContain(host === "cloudflare-pages" ? "cloudflare pages" : host);
  });
}

test("a site written with a host still has only the template's files plus package.json", async () => {
  await create(["my-site", "--host", "vercel"], cwd, notTTY());

  const template = listedTemplate().map((file) => (file === "_gitignore" ? ".gitignore" : file));
  expect(filesUnder(join(cwd, "my-site"))).toEqual([...template, "package.json"].sort());
});

test("the executable writes a refusal to stderr and exits 2", async () => {
  const failed = await execFileAsync(process.execPath, [BIN, "My Site"], { cwd }).then(
    () => {
      throw new Error("create-pagedeck succeeded on an invalid name");
    },
    (error: unknown) => error as { code: number; stdout: string; stderr: string },
  );

  expect(failed.code).toBe(2);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toBe(`${await refusal(["My Site"], notTTY())}\n`);
  expect(readdirSync(cwd)).toEqual([]);
}, 30_000);

test("the executable writes a failure to write as its message and cause, with no stack, and exits 1", async () => {
  const target = join(lockedDirectory(), "my-site");

  const failed = await execFileAsync(process.execPath, [BIN, join("locked", "my-site")], { cwd }).then(
    () => {
      throw new Error("create-pagedeck succeeded in a directory it cannot write");
    },
    (error: unknown) => error as { code: number; stdout: string; stderr: string },
  );

  expect(failed.code).toBe(1);
  expect(failed.stdout).toBe("");
  const [line, ...rest] = failed.stderr.split("\n");
  expect(line).toMatch(
    `Directory "${target}": could not write the site — check that you can write there and the disk has room, delete anything written so far, and run create-pagedeck again: EACCES`,
  );
  expect(rest).toEqual([""]);
}, 30_000);

test("the executable writes the site and prints the next steps to stdout", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, "my-site"], { cwd });

  expect(stderr).toBe("");
  expect(stdout).toContain("  npx pagedeck dev\n");
  expect(existsSync(join(cwd, "my-site", ".gitignore"))).toBe(true);
}, 30_000);

test("the executable's stdio is a pipe, not a terminal, so it never prompts", async () => {
  // No directory given: on a terminal this would hang on a prompt. Off one — which is what a
  // spawned child's piped stdio is — it is the pre-existing "no directory given" refusal.
  const failed = await execFileAsync(process.execPath, [BIN], { cwd }).then(
    () => {
      throw new Error("create-pagedeck succeeded with no directory and no terminal");
    },
    (error: unknown) => error as { code: number; stdout: string; stderr: string },
  );

  expect(failed.code).toBe(2);
  expect(failed.stderr).toBe(
    "Arguments: no directory given — pass the directory to create the site in, as in npm create pagedeck@latest my-site\n",
  );
}, 30_000);

test("on a terminal, prompts for a missing directory and a missing host, defaulting a blank answer", async () => {
  const { io, prompts } = tty(["", ""]);

  const message = await create([], cwd, io);

  expect(prompts()).toContain("Directory");
  expect(prompts()).toContain("Host");
  expect(message).toContain(`Created "my-site" in ${join(cwd, "my-site")}.`);
  expect(existsSync(join(cwd, "my-site", "pagedeck.config.ts"))).toBe(true);
  expect(manifestOf(join(cwd, "my-site")).dependencies?.["@pagedeck/adapter-netlify"]).toBeUndefined();
});

test("on a terminal, an answered directory and host are used as given", async () => {
  const { io } = tty(["custom-site", "netlify"]);

  const message = await create([], cwd, io);

  expect(message).toContain(`Created "custom-site" in ${join(cwd, "custom-site")}, set up for Netlify.`);
  const config = readFileSync(join(cwd, "custom-site", "pagedeck.config.ts"), "utf8");
  expect(config).toContain('import { netlify } from "@pagedeck/adapter-netlify";');
});

test("on a terminal, only the value an argument did not give is prompted for", async () => {
  const { io, prompts } = tty(["vercel"]);

  await create(["given-site"], cwd, io);

  expect(prompts()).not.toContain("Directory");
  expect(prompts()).toContain("Host");
  const config = readFileSync(join(cwd, "given-site", "pagedeck.config.ts"), "utf8");
  expect(config).toContain('import { vercel } from "@pagedeck/adapter-vercel";');
});

test("on a terminal, nothing is prompted when both the directory and the host are given", async () => {
  const { io, prompts } = tty([]);

  await create(["given-site", "--host", "none"], cwd, io);

  expect(prompts()).toBe("");
});

test("on a terminal, an invalid typed host is refused the same way as an invalid --host", async () => {
  const { io } = tty(["my-site", "fastly"]);

  const error = await failure([], io);

  expect(error).toBeInstanceOf(ArgumentError);
  expect(error.message).toBe(
    'Arguments: --host "fastly" is not supported — use one of: vercel, cloudflare-pages, netlify, none',
  );
});

test("--yes takes every default and prompts nothing, even on a terminal", async () => {
  const { io, prompts } = tty([]);

  const message = await create(["--yes"], cwd, io);

  expect(prompts()).toBe("");
  expect(message).toContain(`Created "my-site" in ${join(cwd, "my-site")}.`);
  expect(message).not.toContain("set up for");
});

test("--yes still takes a given directory and host, asking nothing else", async () => {
  const { io, prompts } = tty([]);

  await create(["my-site", "--host", "netlify", "--yes"], cwd, io);

  expect(prompts()).toBe("");
  expect(manifestOf(join(cwd, "my-site")).dependencies?.["@pagedeck/adapter-netlify"]).toBeDefined();
});
