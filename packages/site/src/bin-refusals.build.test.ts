// The helpers mirror `packages/core/src/cli.test.ts`'s rather than import them: they
// live in another package's test file, and read `runCli`'s output, not stderr.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  buildManifest,
  describeError,
  EXIT_CODES,
  manifestJson,
  planEntries,
  planRouting,
  planTiers,
  readManifest,
  RETENTION_DIR,
} from "@pagedeck/core";
import type { Manifest, Page } from "@pagedeck/core";

const DEPLOY = join(import.meta.dirname, "..", "dist", "deploy.bin.js");
const PARITY = join(import.meta.dirname, "..", "dist", "parity.bin.js");

const FORGED_ARG = 'x"\n\u001B[Kfw: Site build: 0 problems\r';

const CWD = mkdtempSync(join(tmpdir(), "pagedeck-bin-refusals-"));

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function runBin(bin: string, args: readonly string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [bin, ...args], { cwd: CWD }, (error, out, err) => {
      done({ code: error === null ? 0 : (error.code as number | null), out, err });
    });
  });
}

function writtenWithoutForgery(
  forged: Run,
  plain: Run,
  code: number = EXIT_CODES.configError,
): string[] {
  expect(forged.code).toBe(code);
  expect(plain.code).toBe(code);
  const written = forged.err.split("\n");
  expect(written).toHaveLength(plain.err.split("\n").length);
  expect(written.some((line) => /^pagedeck: Site build/.test(line))).toBe(false);
  expect(written.some((line) => /[\u0000-\u001F\u007F]/.test(line))).toBe(false);
  return written;
}

function writeBuild(dir: string, id = "b1"): void {
  const home: Page = { locale: "en", path: "/", output: "/", dependencies: [] };
  const entries = planEntries([{ page: home, islands: [] }], { modules: {} });
  const manifest = buildManifest({
    build: { id, createdAt: "2026-09-26T10:00:00.000Z" },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [home], trailingSlash: "never" }),
    pages: [home],
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs: [
      {
        path: "/index.html",
        kind: "html",
        page: { locale: "en", path: "/" },
        contents: "<!doctype html><title>Home</title>",
      },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), manifestJson(manifest), "utf8");
}

const q = (value: string): string => JSON.stringify(value);

test("an unknown option on deploy.bin cannot forge a line in its refusal", async () => {
  const option = `--${FORGED_ARG}`;

  const written = writtenWithoutForgery(
    await runBin(DEPLOY, [option]),
    await runBin(DEPLOY, ["--bogus"]),
  );

  expect(written[0]).toBe(`Unknown option ${q(option)}.`);
}, 60_000);

test("an option given twice on deploy.bin cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", FORGED_ARG, "--origin", FORGED_ARG]),
    await runBin(DEPLOY, ["--origin", "a", "--origin", "b"]),
  );

  expect(written[0]).toBe(
    `Option "--origin" is given twice, as ${q(FORGED_ARG)} and as ${q(FORGED_ARG)} — two sources for one value are refused rather than ranked; pass it once.`,
  );
}, 60_000);

test("--rollback and --from together on deploy.bin cannot forge a line in the refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", "o", "--rollback", FORGED_ARG, "--from", FORGED_ARG]),
    await runBin(DEPLOY, ["--origin", "o", "--rollback", "b1", "--from", "live.json"]),
  );

  expect(written[0]).toBe(
    `Options "--rollback" and "--from" are given together, as ${q(FORGED_ARG)} and ${q(FORGED_ARG)} — a rollback deploys the retained build over what "--out" says is live, so there is no second source for that side; drop "--from", or drop "--rollback" to plan a deploy.`,
  );
}, 60_000);

test("a rollback on deploy.bin with no manifest at --out cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", "o", "--out", FORGED_ARG, "--rollback", FORGED_ARG]),
    await runBin(DEPLOY, ["--origin", "o", "--out", "missing", "--rollback", "b1"]),
  );

  expect(written[0]).toBe(
    `Rollback to build ${q(FORGED_ARG)}: there is no manifest at ${q(join(resolve(CWD, FORGED_ARG), "manifest.json"))}, so there is nothing to roll back from — run pagedeck build first, or pass --out`,
  );
}, 60_000);

test("a deploy on deploy.bin with no manifest at --out cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", "o", "--out", FORGED_ARG]),
    await runBin(DEPLOY, ["--origin", "o", "--out", "missing"]),
  );

  expect(written[0]).toBe(
    `Deploy: there is no manifest at ${q(join(resolve(CWD, FORGED_ARG), "manifest.json"))} — run pagedeck build first, or pass --out`,
  );
}, 60_000);

test("a missing --from on deploy.bin cannot forge a line in its refusal", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);

  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", "o", "--out", out, "--from", FORGED_ARG]),
    await runBin(DEPLOY, ["--origin", "o", "--out", out, "--from", "missing.json"]),
  );

  expect(written[0]).toBe(
    `Deploy: there is no manifest at ${q(resolve(CWD, FORGED_ARG))} — pass --from the manifest.json the live build wrote, or omit it to read the one the origin holds`,
  );
}, 60_000);

const REFUSED: readonly (readonly [string, (text: string) => string])[] = [
  ["is not JSON", () => "{ not json"],
  [
    "is another version",
    (text) => JSON.stringify({ ...(JSON.parse(text) as object), version: 1 }),
  ],
  [
    "has a field of the wrong shape",
    (text) => JSON.stringify({ ...(JSON.parse(text) as object), files: "none" }),
  ],
];

function writeRefused(dir: string, spoil: (text: string) => string): string {
  writeBuild(dir, "b0");
  const file = join(dir, "manifest.json");
  writeFileSync(file, spoil(readFileSync(file, "utf8")), "utf8");
  return file;
}

function refusalOf(file: string): string {
  try {
    readManifest(readFileSync(file, "utf8"), file);
  } catch (error) {
    return describeError(error);
  }
  throw new Error(`${file} was not refused`);
}

test("a deploy on deploy.bin over an origin with no manifest is a first deploy", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);

  const run = await runBin(DEPLOY, ["--origin", mkdtempSync(join(CWD, "origin-")), "--out", out]);

  expect(run.code).toBe(EXIT_CODES.success);
  expect(run.out).toContain("Deploy (first deploy) -> b1");
}, 60_000);

test("a deploy on deploy.bin to an --origin that does not exist is a first deploy", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);

  const run = await runBin(DEPLOY, ["--origin", join(CWD, "no-such-origin"), "--out", out]);

  expect(run.code).toBe(EXIT_CODES.success);
  expect(run.out).toContain("Deploy (first deploy) -> b1");
}, 60_000);

test("a deploy on deploy.bin over an origin with a well-formed manifest plans from it", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  writeBuild(origin, "b0");

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

  expect(run.code).toBe(EXIT_CODES.success);
  expect(run.out).toContain("Deploy b0 -> b1");
}, 60_000);

function writeSite(
  dir: string,
  id: string,
  createdAt: string,
  paths: readonly `/${string}`[],
): Manifest {
  const pages: Page[] = paths.map((path) => ({
    locale: "en",
    path,
    output: path,
    dependencies: [],
  }));
  const entries = planEntries(
    pages.map((page) => ({ page, islands: [] })),
    { modules: {} },
  );
  const outputs = pages.map((page) => ({
    path: page.path === "/" ? "/index.html" : `${page.path}.html`,
    kind: "html" as const,
    page: { locale: "en", path: page.path },
    contents: `<!doctype html><title>${page.path}</title>`,
  }));
  const manifest = buildManifest({
    build: { id, createdAt },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages, trailingSlash: "never" }),
    pages,
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs,
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), manifestJson(manifest), "utf8");
  for (const output of outputs) writeFileSync(join(dir, output.path), output.contents, "utf8");
  return manifest;
}

function writeDeployedOrigin(origin: string, manifest: Manifest, deployedAt?: string): void {
  const history = join(origin, RETENTION_DIR);
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, `${manifest.build.id}.json`), manifestJson(manifest), "utf8");
  if (deployedAt !== undefined) {
    writeFileSync(join(history, `${manifest.build.id}.deployed-at`), `${deployedAt}\n`, "utf8");
  }
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files[file.slice(dir.length)] = readFileSync(file, "utf8");
  }
  return files;
}

function damagedOrigin(origin: string, builds: number, served?: string): string {
  const manifest = q(join(origin, "manifest.json"));
  const history = join(origin, RETENTION_DIR);
  const head = `Deploy: there is no manifest at ${manifest}, but the origin's deploy history at ${q(history)} holds ${String(builds)} ${builds === 1 ? "build" : "builds"}, so the origin is damaged rather than new; `;
  if (served === undefined) {
    return `${head}the deploy instants there do not say which build the origin serves — copy the history file the last apply's "Filed this build" line names to ${manifest}, or pass --from that file`;
  }
  const document = q(join(history, `${served}.json`));
  return `${head}build ${q(served)} has the newest deploy instant there, so it is the build the origin last served — copy ${document} to ${manifest}, or pass --from ${document}`;
}

test("a deploy on deploy.bin over an origin with history but no manifest is refused, and uploads and prunes nothing", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeSite(out, "b1", "2026-09-26T10:00:00.000Z", ["/"]);
  // b0 served /old, and b1 does not: a page has no grace period (#555), so a
  // prune planned over this origin as a first deploy deletes it on the spot.
  const origin = mkdtempSync(join(CWD, "origin-"));
  const b0 = writeSite(origin, "b0", "2026-09-25T10:00:00.000Z", ["/", "/old"]);
  writeDeployedOrigin(origin, b0, "2026-09-25T12:00:00.000Z");
  // Stamped after b0 and deployed before it, so its stamp would name the wrong
  // build: the served one is the one deployed last.
  const earlier = writeSite(
    mkdtempSync(join(CWD, "earlier-")),
    "b-earlier",
    "2026-09-25T11:00:00.000Z",
    ["/"],
  );
  writeDeployedOrigin(origin, earlier, "2026-09-24T12:00:00.000Z");
  rmSync(join(origin, "manifest.json"));
  const before = snapshot(origin);

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out, "--apply", "--prune"]);

  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.err.split("\n")[0]).toBe(damagedOrigin(origin, 2, "b0"));
  expect(run.err).toContain(`copy ${q(join(origin, RETENTION_DIR, "b0.json"))} to`);
  expect(run.out).toBe("");
  expect(snapshot(origin)).toEqual(before);
}, 60_000);

test("a deploy on deploy.bin over an origin with history and a dangling manifest link is refused", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  writeDeployedOrigin(origin, writeSite(origin, "b0", "2026-09-25T10:00:00.000Z", ["/"]));
  rmSync(join(origin, "manifest.json"));
  symlinkSync(join(origin, "gone.json"), join(origin, "manifest.json"));

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.err.split("\n")[0]).toBe(damagedOrigin(origin, 1));
  expect(run.out).toBe("");
}, 60_000);

test("a deploy on deploy.bin over an origin with history, no manifest and an unreadable deploy instant names no build", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  writeDeployedOrigin(origin, writeSite(origin, "b0", "2026-09-25T10:00:00.000Z", ["/"]), "soon");
  rmSync(join(origin, "manifest.json"));

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.err.split("\n")[0]).toBe(damagedOrigin(origin, 1));
  expect(run.out).toBe("");
}, 60_000);

test("a deploy on deploy.bin over an origin with history, no manifest, one readable and one unreadable deploy instant names no build", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  writeDeployedOrigin(
    origin,
    writeSite(origin, "b0", "2026-09-25T10:00:00.000Z", ["/"]),
    "2026-09-25T12:00:00.000Z",
  );
  const other = writeSite(mkdtempSync(join(CWD, "other-")), "b-other", "2026-09-24T10:00:00.000Z", [
    "/",
  ]);
  writeDeployedOrigin(origin, other, "soon");
  rmSync(join(origin, "manifest.json"));

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.err.split("\n")[0]).toBe(damagedOrigin(origin, 2));
  expect(run.out).toBe("");
}, 60_000);

test("a deploy on deploy.bin over an origin with history and no manifest names the build with an instant over one deployed before instants", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  // Deployed before #403, so no instant: stamped later all the same, which a
  // stamp order would take for the served build.
  const before403 = writeSite(mkdtempSync(join(CWD, "old-")), "b-old", "2026-09-25T11:00:00.000Z", [
    "/",
  ]);
  writeDeployedOrigin(origin, before403);
  writeDeployedOrigin(
    origin,
    writeSite(origin, "b0", "2026-09-25T10:00:00.000Z", ["/"]),
    "2026-09-25T12:00:00.000Z",
  );
  rmSync(join(origin, "manifest.json"));

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

  expect(run.code).toBe(EXIT_CODES.configError);
  expect(run.err.split("\n")[0]).toBe(damagedOrigin(origin, 2, "b0"));
  expect(run.out).toBe("");
}, 60_000);

test("a deploy on deploy.bin over an origin with history but no manifest plans from --from", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  writeDeployedOrigin(origin, writeSite(origin, "b0", "2026-09-25T10:00:00.000Z", ["/"]));
  rmSync(join(origin, "manifest.json"));

  const run = await runBin(DEPLOY, [
    "--origin",
    origin,
    "--out",
    out,
    "--from",
    join(origin, RETENTION_DIR, "b0.json"),
  ]);

  expect(run.code).toBe(EXIT_CODES.success);
  expect(run.out).toContain("Deploy b0 -> b1");
}, 60_000);

test("a deploy on deploy.bin over an origin whose history directory is empty is a first deploy", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  const origin = mkdtempSync(join(CWD, "origin-"));
  mkdirSync(join(origin, RETENTION_DIR), { recursive: true });

  const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

  expect(run.code).toBe(EXIT_CODES.success);
  expect(run.out).toContain("Deploy (first deploy) -> b1");
}, 60_000);

for (const [how, spoil] of REFUSED) {
  test(`a deploy on deploy.bin over an origin whose manifest ${how} reports the refusal`, async () => {
    const out = mkdtempSync(join(CWD, "out-"));
    writeBuild(out);
    const origin = mkdtempSync(join(CWD, "origin-"));
    const file = writeRefused(origin, spoil);

    const run = await runBin(DEPLOY, ["--origin", origin, "--out", out]);

    expect(run.code).toBe(EXIT_CODES.configError);
    expect(run.out).not.toContain("first deploy");
    expect(run.err.split("\n")[0]).toBe(refusalOf(file));
  }, 60_000);

  test(`a deploy on deploy.bin whose --from manifest ${how} reports the refusal`, async () => {
    const out = mkdtempSync(join(CWD, "out-"));
    writeBuild(out);
    const file = writeRefused(mkdtempSync(join(CWD, "from-")), spoil);

    const run = await runBin(DEPLOY, ["--origin", "o", "--out", out, "--from", file]);

    expect(run.code).toBe(EXIT_CODES.configError);
    expect(run.err.split("\n")[0]).toBe(refusalOf(file));
  }, 60_000);

  test(`a deploy on deploy.bin whose --out manifest ${how} reports the refusal`, async () => {
    const out = mkdtempSync(join(CWD, "out-"));
    const file = writeRefused(out, spoil);

    const run = await runBin(DEPLOY, ["--origin", "o", "--out", out]);

    expect(run.code).toBe(EXIT_CODES.configError);
    expect(run.err.split("\n")[0]).toBe(refusalOf(file));
  }, 60_000);
}

test("a --from on deploy.bin that cannot be opened is reported, not read as absent", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  // A directory: there, so not a first deploy, and `readFile` fails on it.
  const from = mkdtempSync(join(CWD, "from-"));

  const run = await runBin(DEPLOY, ["--origin", "o", "--out", out, "--from", from]);

  expect(run.code).toBe(EXIT_CODES.configError);
  expect(
    run.err.split("\n")[0]?.startsWith(`Manifest ${q(from)}: could not be opened (EISDIR`),
  ).toBe(true);
}, 60_000);

test("a refused --from on deploy.bin cannot forge a line in its refusal", async () => {
  const out = mkdtempSync(join(CWD, "out-"));
  writeBuild(out);
  mkdirSync(join(CWD, "refused"), { recursive: true });
  const forged = join("refused", FORGED_ARG);
  writeFileSync(join(CWD, forged), "{ not json", "utf8");
  writeFileSync(join(CWD, "refused", "plain.json"), "{ not json", "utf8");

  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", "o", "--out", out, "--from", forged]),
    await runBin(DEPLOY, ["--origin", "o", "--out", out, "--from", "refused/plain.json"]),
  );

  expect(written[0]?.startsWith(`Manifest ${q(resolve(CWD, forged))}: is not valid JSON`)).toBe(
    true,
  );
}, 60_000);

test("an unknown verb on parity.bin cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(PARITY, [FORGED_ARG]),
    await runBin(PARITY, ["bogus"]),
  );

  expect(written[0]).toBe(`Unknown verb ${q(FORGED_ARG)} — use one of: capture, compare.`);
}, 60_000);

test("an unknown option on parity.bin cannot forge a line in its refusal", async () => {
  const option = `--${FORGED_ARG}`;

  const written = writtenWithoutForgery(
    await runBin(PARITY, ["compare", option]),
    await runBin(PARITY, ["compare", "--bogus"]),
  );

  expect(written[0]).toBe(`Unknown option ${q(option)}.`);
}, 60_000);

test("an option given twice on parity.bin cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(PARITY, ["compare", "--build", FORGED_ARG, "--build", FORGED_ARG]),
    await runBin(PARITY, ["compare", "--build", "a", "--build", "b"]),
  );

  expect(written[0]).toBe(
    `Option "--build" is given twice, as ${q(FORGED_ARG)} and as ${q(FORGED_ARG)} — two sources for one value are refused rather than ranked; pass it once.`,
  );
}, 60_000);

test("an unreadable --baseline on parity.bin cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(PARITY, ["compare", "--build", "site", "--baseline", FORGED_ARG]),
    await runBin(PARITY, ["compare", "--build", "site", "--baseline", "missing.json"]),
  );

  expect(
    written[0]?.startsWith(
      `Parity baseline ${q(resolve(CWD, FORGED_ARG))}: could not be read — capture one with parity capture, or drop --baseline to compare against the declared baseline`,
    ),
  ).toBe(true);
}, 60_000);

test("an --apply on deploy.bin whose --out lacks a planned file cannot forge a line in its failure", async () => {
  const forgedOut = join("apply", FORGED_ARG);
  writeBuild(join(CWD, forgedOut));
  writeBuild(join(CWD, "apply", "plain"));

  // Not a refusal of the command line: a missing file is I/O, and exits 1.
  const written = writtenWithoutForgery(
    await runBin(DEPLOY, ["--origin", "origin-forged", "--out", forgedOut, "--apply"]),
    await runBin(DEPLOY, ["--origin", "origin-plain", "--out", "apply/plain", "--apply"]),
    EXIT_CODES.syncFailed,
  );

  expect(
    written[0]?.startsWith(
      `Deploy of "/index.html": the source tree at ${q(resolve(CWD, forgedOut))} does not hold this file`,
    ),
  ).toBe(true);
}, 60_000);

test("a --build with no manifest on parity.bin cannot forge a line in its refusal", async () => {
  const written = writtenWithoutForgery(
    await runBin(PARITY, ["compare", "--build", FORGED_ARG]),
    await runBin(PARITY, ["compare", "--build", "missing"]),
  );

  expect(
    written[0]?.startsWith(
      `Parity build ${q(resolve(CWD, FORGED_ARG))}: has no manifest.json, so there is no build to read parity facts off — run pagedeck build, or pass --build the directory one wrote`,
    ),
  ).toBe(true);
}, 60_000);

test("a --baseline that is not JSON on parity.bin cannot forge a line in its refusal", async () => {
  const forged = join("baselines", FORGED_ARG);
  mkdirSync(join(CWD, "baselines"), { recursive: true });
  writeFileSync(join(CWD, forged), "not json", "utf8");
  writeFileSync(join(CWD, "baselines", "plain.json"), "not json", "utf8");

  const written = writtenWithoutForgery(
    await runBin(PARITY, ["compare", "--build", "site", "--baseline", forged]),
    await runBin(PARITY, ["compare", "--build", "site", "--baseline", "baselines/plain.json"]),
  );

  expect(
    written[0]?.startsWith(`Parity baseline ${q(resolve(CWD, forged))}: is not valid JSON`),
  ).toBe(true);
}, 60_000);
