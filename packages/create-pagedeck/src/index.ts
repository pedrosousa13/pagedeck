import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const PACKAGE = join(import.meta.dirname, "..");

const TEMPLATE = join(PACKAGE, "template");

const LISTED = "template/";

// npm and pnpm leave every file named `.gitignore` out of a tarball.
const PACKED_GITIGNORE = "_gitignore";

const PAGEDECK_PACKAGES = [
  "@pagedeck/content",
  "@pagedeck/core",
  "@pagedeck/islands",
  "@pagedeck/markdown-loader",
] as const;

const SITE_DEPENDENCIES = { react: "^19.2.0", "react-dom": "^19.2.0" } as const;

const SITE_DEV_DEPENDENCIES = { "@types/react": "^19.2.0" } as const;

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

const NAME_LIMIT = 214;

const EXAMPLE = "as in npm create pagedeck@latest my-site";

const NEVER_OVERWRITES =
  "pass a directory that does not exist yet or is empty; create-pagedeck never writes over files";

export class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

function directoryOf(args: readonly string[]): string {
  const { tokens } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = tokens.flatMap((token) =>
    token.kind === "option" ? [`"${token.rawName}"`] : [],
  );
  if (options.length > 0) {
    const given =
      options.length === 1 ? options[0] : `${String(options.length)}: ${options.join(", ")}`;
    throw new ArgumentError(
      `Arguments: create-pagedeck takes no options, and was given ${given} — pass only the directory, ${EXAMPLE}`,
    );
  }
  const positionals = tokens.flatMap((token) =>
    token.kind === "positional" ? [token.value] : [],
  );
  const [directory] = positionals;
  if (directory === undefined) {
    throw new ArgumentError(
      `Arguments: no directory given — pass the directory to create the site in, ${EXAMPLE}`,
    );
  }
  if (positionals.length > 1) {
    throw new ArgumentError(
      `Arguments: ${String(positionals.length)} directories given (${positionals.map((given) => `"${given}"`).join(", ")}) — pass one, ${EXAMPLE}`,
    );
  }
  return directory;
}

function suggestedName(name: string): string {
  const suggested = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|-+$/g, "")
    .slice(0, NAME_LIMIT);
  return suggested === "" ? "my-site" : suggested;
}

function checkName(target: string): string {
  const name = basename(target);
  if (name.length <= NAME_LIMIT && NAME.test(name)) return name;
  throw new ArgumentError(
    `Directory "${target}": the site's package.json takes its name from the directory, and "${name}" is not a valid npm package name — pass a name of at most ${String(NAME_LIMIT)} lowercase letters, digits, "-", "." and "_" that starts with a letter or digit, such as "${suggestedName(name)}"`,
  );
}

function checkEmpty(target: string): void {
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) {
    throw new ArgumentError(`Directory "${target}": is a file, not a directory — ${NEVER_OVERWRITES}`);
  }
  const entries = readdirSync(target).sort();
  if (entries.length > 0) {
    throw new ArgumentError(
      `Directory "${target}": already holds ${String(entries.length)} ${entries.length === 1 ? "entry" : "entries"} (${entries.join(", ")}) — ${NEVER_OVERWRITES}`,
    );
  }
}

export function create(args: readonly string[], cwd: string): string {
  const directory = directoryOf(args);
  const target = resolve(cwd, directory);
  const name = checkName(target);
  checkEmpty(target);

  const { version, files } = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
    version: string;
    files: string[];
  };
  const manifest = {
    name,
    private: true,
    type: "module",
    dependencies: {
      ...Object.fromEntries(PAGEDECK_PACKAGES.map((dependency) => [dependency, version])),
      ...SITE_DEPENDENCIES,
    },
    devDependencies: SITE_DEV_DEPENDENCIES,
  };
  try {
    // package.json's "files" names each template file one by one; npm packs those and
    // the site gets those, so a stray file in template/ reaches neither (#731).
    for (const listed of files) {
      if (!listed.startsWith(LISTED)) continue;
      const file = listed.slice(LISTED.length);
      const to = join(target, file === PACKED_GITIGNORE ? ".gitignore" : file);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(TEMPLATE, file), to);
    }
    writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (cause) {
    throw new Error(
      `Directory "${target}": could not write the site — check that you can write there and the disk has room, delete anything written so far, and run create-pagedeck again`,
      { cause },
    );
  }

  return [
    `Created "${name}" in ${target}. Next:`,
    "",
    `  cd ${directory}`,
    "  npm install",
    "  npx pagedeck sync",
    "  npx pagedeck dev",
  ].join("\n");
}
