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
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ArgumentError, create } from "./index.js";

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

function failure(args: string[]): Error {
  try {
    create(args, cwd);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`create(${JSON.stringify(args)}) wrote a site where a failure was expected`);
}

function refusal(args: string[]): string {
  const error = failure(args);
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

test("writes exactly the listed template files, with _gitignore written as .gitignore, plus a package.json", () => {
  create(["my-site"], cwd);

  const template = listedTemplate().map((file) => (file === "_gitignore" ? ".gitignore" : file));
  expect(filesUnder(join(cwd, "my-site"))).toEqual([...template, "package.json"].sort());
});

test("the written .gitignore names the store, the output directory, the build records and node_modules", () => {
  create(["my-site"], cwd);

  const ignored = readFileSync(join(cwd, "my-site", ".gitignore"), "utf8").split("\n");
  expect(ignored).toEqual(
    expect.arrayContaining(["node_modules/", "content.db", "site/", ".pagedeck/"]),
  );
});

test("the package.json is named after the directory and depends on @pagedeck/* at create-pagedeck's own version", () => {
  create([join("sites", "my-site")], cwd);

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

test("the React ranges a site is given are the ones the public packages and the workspace declare", () => {
  create(["my-site"], cwd);

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

test("writes into a directory that exists and is empty", () => {
  mkdirSync(join(cwd, "my-site"));

  create(["my-site"], cwd);

  expect(existsSync(join(cwd, "my-site", "pagedeck.config.ts"))).toBe(true);
});

test("prints the next steps, starting from the directory as given", () => {
  expect(create(["my-site"], cwd)).toBe(
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

test("refuses a directory that holds files, naming them, and writes nothing", () => {
  const target = join(cwd, "my-site");
  mkdirSync(target);
  writeFileSync(join(target, "notes.txt"), "keep me\n");

  expect(refusal(["my-site"])).toBe(
    `Directory "${target}": already holds 1 entry (notes.txt) — pass a directory that does not exist yet or is empty; create-pagedeck never writes over files`,
  );
  expect(filesUnder(target)).toEqual(["notes.txt"]);
});

test("refuses a path that is a file, and leaves it as it was", () => {
  writeFileSync(join(cwd, "my-site"), "keep me\n");

  expect(refusal(["my-site"])).toBe(
    `Directory "${join(cwd, "my-site")}": is a file, not a directory — pass a directory that does not exist yet or is empty; create-pagedeck never writes over files`,
  );
  expect(readFileSync(join(cwd, "my-site"), "utf8")).toBe("keep me\n");
});

test("refuses a directory whose name is not a valid package name, suggests one, and writes nothing", () => {
  expect(refusal(["My Site"])).toBe(
    `Directory "${join(cwd, "My Site")}": the site's package.json takes its name from the directory, and "My Site" is not a valid npm package name — pass a name of at most 214 lowercase letters, digits, "-", "." and "_" that starts with a letter or digit, such as "my-site"`,
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses a name longer than npm allows", () => {
  const name = "a".repeat(215);

  expect(refusal([name])).toContain(
    `is not a valid npm package name — pass a name of at most 214 lowercase letters, digits, "-", "." and "_" that starts with a letter or digit, such as "${"a".repeat(214)}"`,
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses a call with no directory", () => {
  expect(refusal([])).toBe(
    "Arguments: no directory given — pass the directory to create the site in, as in npm create pagedeck@latest my-site",
  );
});

test("refuses more than one directory, and writes nothing", () => {
  expect(refusal(["one", "two"])).toBe(
    'Arguments: 2 directories given ("one", "two") — pass one, as in npm create pagedeck@latest my-site',
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses an option, since it takes none, and writes nothing", () => {
  expect(refusal(["my-site", "--template", "blog"])).toBe(
    'Arguments: create-pagedeck takes no options, and was given "--template" — pass only the directory, as in npm create pagedeck@latest my-site',
  );
  expect(readdirSync(cwd)).toEqual([]);
});

test("refuses several options by naming every one", () => {
  expect(refusal(["my-site", "--template", "blog", "-y", "--force"])).toBe(
    'Arguments: create-pagedeck takes no options, and was given 3: "--template", "-y", "--force" — pass only the directory, as in npm create pagedeck@latest my-site',
  );
});

test("a directory it cannot write fails naming the directory and a fix, with Node's error as the cause", () => {
  const target = join(lockedDirectory(), "my-site");

  const error = failure([join("locked", "my-site")]);

  expect(error).not.toBeInstanceOf(ArgumentError);
  expect(error.message).toBe(
    `Directory "${target}": could not write the site — check that you can write there and the disk has room, delete anything written so far, and run create-pagedeck again`,
  );
  expect((error.cause as NodeJS.ErrnoException).code).toBe("EACCES");
});

test("the executable writes a refusal to stderr and exits 2", async () => {
  const failure = await execFileAsync(process.execPath, [BIN, "My Site"], { cwd }).then(
    () => {
      throw new Error("create-pagedeck succeeded on an invalid name");
    },
    (error: unknown) => error as { code: number; stdout: string; stderr: string },
  );

  expect(failure.code).toBe(2);
  expect(failure.stdout).toBe("");
  expect(failure.stderr).toBe(`${refusal(["My Site"])}\n`);
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
