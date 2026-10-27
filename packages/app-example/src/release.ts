// One file with no relative import, so Node runs it with its types stripped from a copy of
// this example outside the repository: `node src/release.ts prepare`.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { diffManifests, racedDeployReport, readManifest, unusableId } from "@pagedeck/core";

const run = promisify(execFile);

const SECRET_NAME = /^\.(dev\.vars|env)(\.|$)/;

export interface ReleaseInput {
  /** The site's root: `pagedeck.config.ts`, `wrangler.jsonc` and the built `site/`. */
  readonly site: string;
  /** Where releases are kept, one directory per build id. */
  readonly releases: string;
}

export interface ReleaseRecord {
  readonly release: string;
  readonly createdAt: string;
  readonly parent?: string;
  readonly worker: string;
  readonly sha256: string;
  readonly wrangler: string;
}

// The site's own wrangler, the version its manifest declares, never whatever `npx` finds.
function wranglerOf(site: string): { bin: string; version: string } {
  const require = createRequire(join(site, "package.json"));
  let path: string;
  try {
    path = require.resolve("wrangler/package.json");
  } catch (cause) {
    throw new Error(
      `Release of "${join(site, "site")}": finds no wrangler installed for "${site}", and the app is bundled with the site's own — add wrangler to its devDependencies at an exact version, install, then prepare again`,
      { cause },
    );
  }
  const manifest = require(path) as { version: string; bin: { wrangler: string } };
  return { bin: join(dirname(path), manifest.bin.wrangler), version: manifest.version };
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Writes `<releases>/<build id>/`: `site/` as built, the site's `wrangler.jsonc`, the app
 * bundled with its release id, and `release.json`. All of it or none: it is written to a
 * staging directory and renamed into place.
 */
export async function prepareRelease(input: ReleaseInput): Promise<{ id: string; dir: string; worker: string }> {
  const tree = join(input.site, "site");
  const subject = `Release of "${tree}"`;

  const secrets = (await filesUnder(tree)).filter((file) => SECRET_NAME.test(basename(file)));
  if (secrets.length > 0) {
    throw new Error(
      `${subject}: holds ${String(secrets.length)} files named like secrets — ${secrets
        .map((file) => `"${file}"`)
        .join(", ")} — wrangler uploads every file there that .assetsignore does not name, so move each one out of public/ (wrangler reads .dev.vars beside wrangler.jsonc), then build again`,
    );
  }

  const manifestPath = join(tree, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${subject}: has no manifest.json, so there is no build id to name the release by — run pagedeck build in "${input.site}" first`,
    );
  }
  const { build } = readManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const dir = join(input.releases, build.id);
  if (existsSync(dir)) {
    throw new Error(
      `${subject}: build "${build.id}" is already a release, at "${dir}" — deploy that one, or run pagedeck build for a new build id`,
    );
  }

  const staging = join(input.releases, `.staging-${build.id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const wrangler = wranglerOf(input.site);
    try {
      await run(
        process.execPath,
        [
          wrangler.bin,
          "deploy",
          "--dry-run",
          "--outdir",
          join(staging, "worker"),
          "--define",
          `PAGEDECK_RELEASE:${JSON.stringify(build.id)}`,
        ],
        { cwd: input.site, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (cause) {
      const { stdout = "", stderr = "" } = cause as { stdout?: string; stderr?: string };
      throw new Error(
        `${subject}: wrangler could not bundle the app, so no release was written — fix the app until "wrangler deploy --dry-run" passes in "${input.site}", then prepare again. wrangler printed, emails and IDs redacted:\n${redact(`${stdout}${stderr}`)}`,
        { cause },
      );
    }
    const bundles = (await readdir(join(staging, "worker"))).filter((file) => file.endsWith(".js"));
    if (bundles.length !== 1) {
      throw new Error(
        `${subject}: wrangler wrote ${String(bundles.length)} JavaScript files where one bundle was expected — ${bundles.join(", ")} — check "main" in wrangler.jsonc names one entry`,
      );
    }
    const worker = `worker/${bundles[0] as string}`;
    await cp(tree, join(staging, "site"), { recursive: true });
    await copyFile(join(input.site, "wrangler.jsonc"), join(staging, "wrangler.jsonc"));
    const record: ReleaseRecord = {
      release: build.id,
      createdAt: build.createdAt,
      ...(build.parent === undefined ? {} : { parent: build.parent }),
      worker,
      sha256: createHash("sha256").update(await readFile(join(staging, worker))).digest("hex"),
      wrangler: wrangler.version,
    };
    await writeFile(join(staging, "release.json"), `${JSON.stringify(record, null, 2)}\n`);
    await rename(staging, dir);
    return { id: build.id, dir, worker };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export interface CheckInput {
  readonly releases: string;
  /** The release about to be deployed. */
  readonly release: string;
  /** The live site's origin, whose `/api/release` names the release it serves. */
  readonly live: string;
}

/**
 * Refuses a release that was not built on the one live, as `pagedeck diff` does. It runs
 * before `wrangler deploy`, which has no such check, so a deploy that lands between the two
 * is not caught.
 */
export async function checkLive(input: CheckInput): Promise<void> {
  const subject = `Release "${input.release}"`;
  const endpoint = new URL("/api/release", input.live).href;
  let response: Response;
  try {
    response = await fetch(endpoint);
  } catch (cause) {
    throw new Error(
      `${subject}: "${input.live}" could not be asked which release it serves — check the origin, or pass --force to deploy without the check`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `${subject}: "${endpoint}" answered ${String(response.status)}, so which release is live is unknown — check the origin, or pass --force to deploy without the check`,
    );
  }
  const live = ((await response.json()) as { release?: unknown }).release;
  if (typeof live !== "string") {
    throw new Error(
      `${subject}: "${endpoint}" names no release, so what is live was not deployed from a prepared release — check it by hand, then pass --force`,
    );
  }
  const unusable = unusableId(live);
  if (unusable !== undefined) {
    throw new Error(
      `${subject}: "${endpoint}" names "${live}" as live, which is not a build id — ${unusable}; check what the origin serves, or pass --force`,
    );
  }
  if (live === input.release) return;

  const [currentPath, candidatePath] = [live, input.release].map((id) => {
    const path = join(input.releases, id, "site", "manifest.json");
    if (!existsSync(path)) {
      throw new Error(
        `${subject}: release "${id}" is not in "${input.releases}" — restore the releases kept outside this runner, or pass --force`,
      );
    }
    return path;
  }) as [string, string];
  const candidate = readManifest(await readFile(candidatePath, "utf8"), candidatePath);
  let current;
  try {
    current = readManifest(await readFile(currentPath, "utf8"), currentPath);
  } catch (cause) {
    throw new Error(
      `${subject}: the live release "${live}" has a manifest this pagedeck cannot read, so nothing says what this release was built on — restoring "${live}" needs no manifest; check what is live by hand, then pass --force`,
      { cause },
    );
  }
  const raced = racedDeployReport(diffManifests({ from: current, to: candidate }));
  if (raced !== undefined) throw new Error(`${subject} over live release "${live}": ${raced}`);
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HEX_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

/** wrangler can print the account's email and ID, which a CI log must not keep. */
export function redact(text: string): string {
  return text.replace(EMAIL, "<email>").replace(HEX_ID, "<id>");
}

const USAGE =
  "usage: node src/release.ts prepare [--releases <dir>]\n       node src/release.ts check <release> --live <origin> [--force] [--releases <dir>]";

async function main(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv;
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--force") options.set(arg, true);
    else if (arg === "--releases" || arg === "--live") {
      const value = rest[(index += 1)];
      if (value === undefined) throw new Error(`${arg} takes a value\n${USAGE}`);
      options.set(arg, value);
    } else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"\n${USAGE}`);
    else positional.push(arg);
  }
  const site = process.cwd();
  const releases = (options.get("--releases") as string | undefined) ?? join(site, "releases");
  if (verb === "prepare" && positional.length === 0) {
    const { id, dir, worker } = await prepareRelease({ site, releases });
    console.log(`Release "${id}" written to "${dir}". To deploy it, there: wrangler deploy ${worker} --no-bundle`);
    return;
  }
  const live = options.get("--live");
  if (verb === "check" && positional.length === 1 && typeof live === "string") {
    if (options.get("--force") === true) {
      console.log("--force: the live release was not checked");
      return;
    }
    await checkLive({ releases, release: positional[0] as string, live });
    console.log(`Release "${positional[0] as string}" was built on what "${live}" serves`);
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
