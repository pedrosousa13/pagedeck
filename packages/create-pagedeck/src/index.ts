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
import { createInterface } from "node:readline/promises";
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

const DEFAULT_DIRECTORY = "my-site";

const HOSTS = ["vercel", "cloudflare-pages", "netlify", "none"] as const;

type Host = (typeof HOSTS)[number];

const DEFAULT_HOST: Host = "none";

interface Adapter {
  readonly dependency: string;
  readonly factory: string;
  readonly label: string;
}

const ADAPTERS: Record<Exclude<Host, "none">, Adapter> = {
  vercel: { dependency: "@pagedeck/adapter-vercel", factory: "vercel", label: "Vercel" },
  "cloudflare-pages": {
    dependency: "@pagedeck/adapter-cloudflare-pages",
    factory: "cloudflarePages",
    label: "Cloudflare Pages",
  },
  netlify: { dependency: "@pagedeck/adapter-netlify", factory: "netlify", label: "Netlify" },
};

const DEPLOY_DOC =
  "https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/how-to/deploy-a-site.md";

// `node` is this package's own `engines.node`, the exact range `deploy-a-site.md` states —
// looser wording such as "22.18.0 or later" would admit 23.0–23.6, which the range excludes.
function deploySection(host: Exclude<Host, "none">, node: string): string {
  switch (host) {
    case "vercel":
      return `## Deploy to Vercel

- Build command: \`npx pagedeck sync && npx pagedeck build\`
- Output directory: \`site\`
- Node.js version: \`22.x\` or \`24.x\` (\`engines.node\` is \`${node}\`)

[Deploy a site](${DEPLOY_DOC}#vercel) covers the rest, including Vercel's
project settings.
`;
    case "cloudflare-pages":
      return `## Deploy to Cloudflare Pages

- Build command: \`npx pagedeck sync && npx pagedeck build\`
- Build output directory: \`site\`
- \`NODE_VERSION\` environment variable: \`22.18.0\` (\`engines.node\` is \`${node}\`)

[Deploy a site](${DEPLOY_DOC}#cloudflare-pages) covers the rest, including why
\`NODE_VERSION\` has to be set explicitly.
`;
    case "netlify":
      return `## Deploy to Netlify

- Build command: \`npx pagedeck sync && npx pagedeck build\`
- Publish directory: \`site\`
- Node.js version: \`22.18.0\`, set in \`netlify.toml\` (\`engines.node\` is \`${node}\`)

[Deploy a site](${DEPLOY_DOC}#netlify) covers the rest.
`;
  }
}

const CORE_IMPORT = 'import { defineConfig, fromCollection } from "@pagedeck/core";';

const COMPONENTS_BLOCK = `    components: {
      layout: "./components/layout.tsx",
      counter: "./components/counter.tsx",
    },
`;

const USAGE = `Usage: create-pagedeck [directory] [--host <${HOSTS.join("|")}>] [--yes]

Creates a new Pagedeck site.

  directory             where to create the site; on a terminal, prompted for
                         when left out (default "${DEFAULT_DIRECTORY}")
  --host <host>          the host to set the site up for (default "${DEFAULT_HOST}");
                         on a terminal, prompted for when left out
  --yes, -y              take every default and ask nothing
  --help                 print this message and exit
`;

export class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

export interface CreateIO {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
}

const OPTIONS = {
  host: { type: "string" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean" },
} as const;

const KNOWN_OPTIONS = new Set<string>(Object.keys(OPTIONS));

function isHost(value: string): value is Host {
  return (HOSTS as readonly string[]).includes(value);
}

function hostFix(given: string): string {
  return `--host "${given}" is not supported — use one of: ${HOSTS.join(", ")}`;
}

interface Arguments {
  readonly help: boolean;
  readonly directory: string | undefined;
  readonly host: string | undefined;
  readonly yes: boolean;
}

function parse(args: readonly string[]): Arguments {
  const { tokens } = parseArgs({
    args: [...args],
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  if (tokens.some((token) => token.kind === "option" && token.name === "help")) {
    return { help: true, directory: undefined, host: undefined, yes: false };
  }

  const unknown = tokens.flatMap((token) =>
    token.kind === "option" && !KNOWN_OPTIONS.has(token.name) ? [`"${token.rawName}"`] : [],
  );
  if (unknown.length > 0) {
    const given =
      unknown.length === 1 ? unknown[0] : `${String(unknown.length)}: ${unknown.join(", ")}`;
    throw new ArgumentError(
      `Arguments: create-pagedeck takes no options besides --host, --yes and --help, and was given ${given} — pass only the directory and those options, ${EXAMPLE}`,
    );
  }

  const hostToken = tokens.find((token) => token.kind === "option" && token.name === "host");
  const host = hostToken?.kind === "option" ? hostToken.value : undefined;
  if (hostToken !== undefined && host === undefined) {
    throw new ArgumentError(
      `Arguments: --host given with no value — use one of: ${HOSTS.join(", ")}`,
    );
  }
  if (host !== undefined && !isHost(host)) {
    throw new ArgumentError(`Arguments: ${hostFix(host)}`);
  }

  const yes = tokens.some((token) => token.kind === "option" && token.name === "yes");

  const positionals = tokens.flatMap((token) =>
    token.kind === "positional" ? [token.value] : [],
  );
  if (positionals.length > 1) {
    throw new ArgumentError(
      `Arguments: ${String(positionals.length)} directories given (${positionals.map((given) => `"${given}"`).join(", ")}) — pass one, ${EXAMPLE}`,
    );
  }

  return { help: false, directory: positionals[0], host, yes };
}

function suggestedName(name: string): string {
  const suggested = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|-+$/g, "")
    .slice(0, NAME_LIMIT);
  return suggested === "" ? DEFAULT_DIRECTORY : suggested;
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

// Only on a TTY: a piped or redirected stream (CI, the pack harness, a plain
// `npm create pagedeck my-site`) asks nothing, so it behaves as it always has.
function isInteractive(io: CreateIO): boolean {
  return io.stdin.isTTY === true && io.stdout.isTTY === true;
}

async function prompted(
  io: CreateIO,
  directory: string | undefined,
  host: string | undefined,
): Promise<{ directory: string; host: Host }> {
  if (directory !== undefined && host !== undefined) {
    return { directory, host: host as Host };
  }
  // `terminal: false`: readline's raw-mode features need a real TTY, which an injected
  // stream does not have, and this CLI only reads one line per question.
  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: false });
  try {
    let resolvedDirectory = directory;
    if (resolvedDirectory === undefined) {
      const answer = (await rl.question(`Directory (${DEFAULT_DIRECTORY}): `)).trim();
      resolvedDirectory = answer === "" ? DEFAULT_DIRECTORY : answer;
    }
    let resolvedHost = host;
    if (resolvedHost === undefined) {
      const answer = (await rl.question(`Host (${HOSTS.join("/")}) (${DEFAULT_HOST}): `)).trim();
      resolvedHost = answer === "" ? DEFAULT_HOST : answer;
      if (!isHost(resolvedHost)) throw new ArgumentError(`Arguments: ${hostFix(resolvedHost)}`);
    }
    return { directory: resolvedDirectory, host: resolvedHost as Host };
  } finally {
    rl.close();
  }
}

function withAdapter(config: string, adapter: Adapter): string {
  return config
    .replace(CORE_IMPORT, `${CORE_IMPORT}\nimport { ${adapter.factory} } from "${adapter.dependency}";`)
    .replace(COMPONENTS_BLOCK, `${COMPONENTS_BLOCK}    adapter: ${adapter.factory}(),\n`);
}

function closingMessage(name: string, directory: string, target: string, host: Host): string {
  const created =
    host === "none"
      ? `Created "${name}" in ${target}. Next:`
      : `Created "${name}" in ${target}, set up for ${ADAPTERS[host].label}. Next:`;
  const next = [
    created,
    "",
    `  cd ${directory}`,
    "  npm install",
    "  npx pagedeck sync",
    "  npx pagedeck dev",
  ];
  if (host !== "none") {
    next.push(
      "",
      `When you're ready to deploy, npx pagedeck build writes the finished site; README.md covers ${ADAPTERS[host].label}'s build settings.`,
    );
  }
  return next.join("\n");
}

export async function create(
  args: readonly string[],
  cwd: string,
  io: CreateIO = { stdin: process.stdin, stdout: process.stdout },
): Promise<string> {
  const parsed = parse(args);
  if (parsed.help) return USAGE;

  let directory: string;
  let host: Host;
  if (parsed.yes) {
    directory = parsed.directory ?? DEFAULT_DIRECTORY;
    host = (parsed.host as Host | undefined) ?? DEFAULT_HOST;
  } else if (isInteractive(io)) {
    ({ directory, host } = await prompted(io, parsed.directory, parsed.host));
  } else {
    if (parsed.directory === undefined) {
      throw new ArgumentError(
        `Arguments: no directory given — pass the directory to create the site in, ${EXAMPLE}`,
      );
    }
    directory = parsed.directory;
    host = (parsed.host as Host | undefined) ?? DEFAULT_HOST;
  }

  const target = resolve(cwd, directory);
  const name = checkName(target);
  checkEmpty(target);

  const { version, files, engines } = JSON.parse(
    readFileSync(join(PACKAGE, "package.json"), "utf8"),
  ) as { version: string; files: string[]; engines: { node: string } };
  const adapter = host === "none" ? undefined : ADAPTERS[host];
  const manifest = {
    name,
    private: true,
    type: "module",
    dependencies: {
      ...Object.fromEntries(PAGEDECK_PACKAGES.map((dependency) => [dependency, version])),
      ...(adapter === undefined ? {} : { [adapter.dependency]: version }),
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
    if (adapter !== undefined) {
      const configPath = join(target, "pagedeck.config.ts");
      writeFileSync(configPath, withAdapter(readFileSync(configPath, "utf8"), adapter));
      const readmePath = join(target, "README.md");
      writeFileSync(
        readmePath,
        `${readFileSync(readmePath, "utf8")}\n${deploySection(host as Exclude<Host, "none">, engines.node)}`,
      );
    }
    writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (cause) {
    throw new Error(
      `Directory "${target}": could not write the site — check that you can write there and the disk has room, delete anything written so far, and run create-pagedeck again`,
      { cause },
    );
  }

  return closingMessage(name, directory, target, host);
}
