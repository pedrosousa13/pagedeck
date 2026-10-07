import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ConfigError, describeError } from "./exit.js";
import { manifestJson, MANIFEST_VERSION } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import {
  DEFAULT_RETENTION_POLICY,
  listRetainedManifests,
  readRetainedManifest,
  RETENTION_DIR,
  retainManifest,
} from "./retention.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function siteRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pagedeck-retention-"));
  roots.push(root);
  return root;
}

function manifest(id: string, createdAt: string, parent?: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    build: { id, createdAt, ...(parent === undefined ? {} : { parent }) },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: {
      version: 1,
      site: { trailingSlash: "never" },
      trees: [{ redirects: [], headers: [] }],
    },
    files: [],
    pages: [],
    tiers: {
      policy: {
        coreMinShare: 0.6,
        coreMinUsageShare: 0.25,
        midMinPages: 2,
        exclude: [],
        minSize: 20000,
        minShareCount: 1,
      },
      pageCount: 0,
      shippedUsages: 0,
      groups: [],
      assignments: [],
    },
    classes: [],
  };
}

async function ids(root: string): Promise<readonly string[]> {
  return (await listRetainedManifests(root)).map((held) => held.build.id);
}

test("a retained manifest comes back out of the store as the document that went in", async () => {
  const root = siteRoot();
  const written = manifest("b1", "2026-08-25T10:00:00.000Z", "b0");

  await retainManifest(root, written);

  expect(await readRetainedManifest(root, "b1")).toEqual(written);
  expect(readdirSync(join(root, RETENTION_DIR))).toEqual(["b1.json"]);
});

test("the store lists newest first by the build's own clock reading, not by the file's", async () => {
  const root = siteRoot();
  // Written oldest last, which is what tells the two orders apart.
  await retainManifest(root, manifest("b2", "2026-08-26T09:30:00.000Z"));
  await retainManifest(root, manifest("b3", "2026-08-27T09:30:00.000Z"));
  await retainManifest(root, manifest("b1", "2026-08-25T10:00:00.000Z"));

  expect(await ids(root)).toEqual(["b3", "b2", "b1"]);
});

test("a store nothing has written yet lists nothing rather than failing", async () => {
  expect(await listRetainedManifests(siteRoot())).toEqual([]);
});

test("retaining prunes everything past the keep count, oldest first", async () => {
  const root = siteRoot();
  for (const [id, createdAt] of [
    ["b3", "2026-08-27T09:30:00.000Z"],
    ["b2", "2026-08-26T09:30:00.000Z"],
    ["b1", "2026-08-25T10:00:00.000Z"],
  ] as const) {
    await retainManifest(root, manifest(id, createdAt), { keep: 3 });
  }

  await retainManifest(root, manifest("b4", "2026-08-28T09:30:00.000Z"), {
    keep: 2,
  });

  expect(await ids(root)).toEqual(["b4", "b3"]);
  expect(readdirSync(join(root, RETENTION_DIR)).sort()).toEqual([
    "b3.json",
    "b4.json",
  ]);
});

test("a site that keeps nothing retains nothing, including the build that just ran", async () => {
  const root = siteRoot();
  await retainManifest(root, manifest("b1", "2026-08-25T10:00:00.000Z"));

  await retainManifest(root, manifest("b2", "2026-08-26T09:30:00.000Z"), {
    keep: 0,
  });

  expect(await ids(root)).toEqual([]);
});

test("the default keeps twenty builds", async () => {
  expect(DEFAULT_RETENTION_POLICY).toEqual({ keep: 20 });

  const root = siteRoot();
  for (let index = 0; index <= 20; index += 1) {
    const day = String(index + 1).padStart(2, "0");
    await retainManifest(
      root,
      manifest(`b${String(index)}`, `2026-08-${day}T10:00:00.000Z`),
    );
  }

  expect((await listRetainedManifests(root)).length).toBe(20);
  expect(await readRetainedManifest(root, "b1")).toBeDefined();
  await expect(readRetainedManifest(root, "b0")).rejects.toBeInstanceOf(
    ConfigError,
  );
});

test("a rollback naming a build this store does not hold is refused by name", async () => {
  const root = siteRoot();
  await retainManifest(root, manifest("b1", "2026-08-25T10:00:00.000Z"));

  const failure: unknown = await readRetainedManifest(root, "b9").catch(
    (thrown: unknown) => thrown,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toBe(
    `Retained manifest "b9": is not in the store at "${join(root, RETENTION_DIR)}" — the retained builds are "b1", so roll back to one of those, or raise build.retention.keep before the build you want is pruned`,
  );
});

test("an empty store says so rather than listing nothing after the dash", async () => {
  const failure: unknown = await readRetainedManifest(siteRoot(), "b9").catch(
    (thrown: unknown) => thrown,
  );

  expect((failure as Error).message).toContain(
    "the store holds no retained build, so run pagedeck build to fill it",
  );
});

test("a build id that is not a path segment is refused at both doors", async () => {
  const root = siteRoot();

  const written: unknown = await retainManifest(
    root,
    manifest("..", "2026-08-25T10:00:00.000Z"),
  ).catch((thrown: unknown) => thrown);
  const read: unknown = await readRetainedManifest(root, "en/us").catch(
    (thrown: unknown) => thrown,
  );

  expect(written).toBeInstanceOf(ConfigError);
  expect((written as Error).message).toBe(
    'Retained manifest "..": the build id is a dot segment, which resolves out of the retention store, and each retained build is written to "<build id>.json" — mint the build id as a name a path can hold, such as a uuid',
  );
  expect(read).toBeInstanceOf(ConfigError);
  expect((read as Error).message).toBe(
    'Retained manifest "en/us": the build id holds "/", which would place the document in another directory, and each retained build is written to "<build id>.json" — mint the build id as a name a path can hold, such as a uuid',
  );
});

// The site root is inside this test's temp directory, so the escape lands somewhere
// `afterEach` removes.
test("a manifest filed under a name that is not its build id prunes itself, not the path its id spells", async () => {
  const owned = siteRoot();
  const root = join(owned, "site");
  mkdirSync(root, { recursive: true });
  const victim = join(owned, "victim.json");
  writeFileSync(victim, "{}");
  const misfiled = plant(
    root,
    "misfiled.json",
    manifestJson(manifest("../../../victim", "2026-08-25T10:00:00.000Z")),
  );

  const warning = await retainManifest(
    root,
    manifest("b2", "2026-08-26T09:30:00.000Z"),
    { keep: 1 },
  );

  expect(existsSync(victim)).toBe(true);
  expect(readdirSync(join(root, RETENTION_DIR))).toEqual(["b2.json"]);
  expect(warning).toBe(
    `Retention store: 1 retained manifest is filed under a name that is not its build id — pagedeck build writes each document to "<build id>.json" and reads it back by that id, so a document filed elsewhere is unreachable by rollback and was written by hand; rename the file to the name its own build id spells, or delete it — and if that id cannot itself be a file name, mint the build id as a name a path can hold, such as a uuid, and file the document under that:\n  "${misfiled}" — the build id is "../../../victim", and the file has been pruned by this build`,
  );
});

test("a build id that is empty, dotted or holds either separator is refused, and a minted one is not", async () => {
  const root = siteRoot();
  const verdict = async (id: string): Promise<string> =>
    await readRetainedManifest(root, id).then(
      () => "accepted",
      (thrown: unknown) =>
        (thrown as Error).message.includes(
          'each retained build is written to "<build id>.json"',
        )
          ? "refused"
          : "accepted",
    );
  const unusable = [
    "",
    ".",
    "..",
    "...",
    "..foo",
    ".hidden",
    "en/us",
    "a\\b",
    "..\\..\\..\\victim",
  ];
  const usable = [
    randomUUID(),
    "build-99",
    "9e1f4a02",
    "main-2026-09-04",
    "main@9e1f4a02",
    "run#7",
  ];

  expect(await Promise.all(unusable.map(verdict))).toEqual(
    unusable.map(() => "refused"),
  );
  expect(await Promise.all(usable.map(verdict))).toEqual(
    usable.map(() => "accepted"),
  );
  await expect(readRetainedManifest(root, "")).rejects.toThrow(
    'Retained manifest "": the build id is empty, so it names the retention store\'s own directory rather than a document in it, and each retained build is written to "<build id>.json" — mint the build id as a name a path can hold, such as a uuid',
  );
  await expect(readRetainedManifest(root, "a\\b")).rejects.toThrow(
    'Retained manifest "a\\\\b": the build id holds "\\", which is a path separator on Windows and would place the document in another directory there, and each retained build is written to "<build id>.json" — mint the build id as a name a path can hold, such as a uuid',
  );
});

test("a planted build id cannot forge a line or erase the marker in the warning", async () => {
  const root = siteRoot();
  const forged = 'b1"\n\u001B[Kfw: Site build: 0 problems\r';
  const planted = plant(
    root,
    "planted.json",
    manifestJson(manifest(forged, "2026-08-25T10:00:00.000Z")),
  );

  const warning = await retainManifest(
    root,
    manifest("b2", "2026-08-26T09:30:00.000Z"),
    { keep: 5 },
  );

  const lines = warning?.split("\n") ?? [];
  expect(lines).toHaveLength(2);
  expect(lines.some((line) => /[\u0000-\u001F\u007F]/.test(line))).toBe(false);
  expect(lines[1]).toBe(
    `  ${JSON.stringify(planted)} — the build id is ${JSON.stringify(forged)}, and the file is still in the store`,
  );
});

test("a build id holding a newline is not refused as a file name", async () => {
  const root = siteRoot();

  const failure: unknown = await readRetainedManifest(
    root,
    "b1\nfw: Site build: 0 problems",
  ).catch((thrown: unknown) => thrown);

  expect((failure as Error).message).not.toContain(
    'each retained build is written to "<build id>.json"',
  );
  expect((failure as Error).message).toContain("is not in the store at");
});

test("an id refused as a file name cannot close the quotation the refusal puts round it", async () => {
  const root = siteRoot();
  const forged = '.a"b\n\u001B[Kfw: Site build: 0 problems\r';

  const failure: unknown = await readRetainedManifest(root, forged).catch(
    (thrown: unknown) => thrown,
  );

  const written = describeError(failure);
  expect(written).toContain("the build id starts with a dot");
  expect(written).toContain(JSON.stringify(forged));
  expect(written.split("\n")).toHaveLength(1);
  expect(/[\u0000-\u001F\u007F]/.test(written)).toBe(false);
});

test("a rollback target that could forge a line is quoted in the message that refuses it", async () => {
  const root = siteRoot();
  const forged = 'b1"\n\u001B[Kfw: Site build: 0 problems\r';

  const failure: unknown = await readRetainedManifest(root, forged).catch(
    (thrown: unknown) => thrown,
  );

  const written = describeError(failure);
  expect(written.split("\n")).toHaveLength(1);
  expect(written).toContain(JSON.stringify(forged));
  expect(written).toContain("ENOENT");
  expect(/[\u0000-\u001F\u007F]/.test(written)).toBe(false);
});

test("a retained file name that could forge a line is quoted in the list of what the store holds", async () => {
  const root = siteRoot();
  const forged = 'b1"\n\u001B[Kfw: Site build: 0 problems\r';
  plant(
    root,
    `${forged}.json`,
    manifestJson(manifest("b1", "2026-08-25T10:00:00.000Z")),
  );

  const failure: unknown = await readRetainedManifest(root, "b2").catch(
    (thrown: unknown) => thrown,
  );

  const written = describeError(failure);
  expect(written.split("\n")).toHaveLength(1);
  expect(written).toContain(JSON.stringify(forged));
  expect(/[\u0000-\u001F\u007F]/.test(written)).toBe(false);
});

function plant(root: string, name: string, text: string): string {
  const dir = join(root, RETENTION_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

function priorVersion(id: string, createdAt: string): string {
  return manifestJson({
    ...manifest(id, createdAt),
    version: MANIFEST_VERSION - 1,
  });
}

test("a store holding a document this build cannot read still lists the newest one it can", async () => {
  const root = siteRoot();
  await retainManifest(root, manifest("b1", "2026-08-25T10:00:00.000Z"));
  await retainManifest(root, manifest("b2", "2026-08-26T09:30:00.000Z"));
  plant(root, "b3.json", priorVersion("b3", "2026-08-27T09:30:00.000Z"));

  expect(await ids(root)).toEqual(["b2", "b1"]);
});

test("retaining prunes the document no build can read, and reports it", async () => {
  const root = siteRoot();
  const file = plant(
    root,
    "b1.json",
    priorVersion("b1", "2026-08-25T10:00:00.000Z"),
  );

  const warning = await retainManifest(
    root,
    manifest("b2", "2026-08-26T09:30:00.000Z"),
  );

  expect(readdirSync(join(root, RETENTION_DIR))).toEqual(["b2.json"]);
  expect(warning).toBe(
    `Retention store: 1 retained manifest could not be read and has been pruned — a build reads the store to record its own parent and to prune by the site's keep count, and a document this pagedeck cannot read answers neither; ignore this once after a pagedeck upgrade, or pin one pagedeck version across CI and local if it returns on every build:\n  Manifest "${file}": is version ${String(MANIFEST_VERSION - 1)}, and this build reads version ${String(MANIFEST_VERSION)} — upgrade pagedeck, or read a manifest this version wrote`,
  );
});

test("a file in the store that is not JSON at all is pruned with its own reason", async () => {
  const root = siteRoot();
  const file = plant(root, "b1.json", "{ not json");

  const warning = await retainManifest(
    root,
    manifest("b2", "2026-08-26T09:30:00.000Z"),
  );

  expect(readdirSync(join(root, RETENTION_DIR))).toEqual(["b2.json"]);
  expect(warning).toContain(
    `Manifest "${file}": is not valid JSON — pagedeck build writes it, so re-run the build that produced it`,
  );
});

test("a build over a store it can read reports nothing", async () => {
  const root = siteRoot();

  expect(
    await retainManifest(root, manifest("b1", "2026-08-25T10:00:00.000Z")),
  ).toBeUndefined();
});

test("a document in the store this build cannot read is refused by the manifest reader", async () => {
  const root = siteRoot();
  const dir = join(root, RETENTION_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "b1.json");
  writeFileSync(
    file,
    manifestJson({
      ...manifest("b1", "2026-08-25T10:00:00.000Z"),
      version: MANIFEST_VERSION - 1,
    }),
  );

  const failure: unknown = await readRetainedManifest(root, "b1").catch(
    (thrown: unknown) => thrown,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).toBe(
    `Manifest "${file}": is version ${String(MANIFEST_VERSION - 1)}, and this build reads version ${String(MANIFEST_VERSION)} — upgrade pagedeck, or read a manifest this version wrote`,
  );
});

test("a retained document with no build stamp is pruned as unreadable rather than thrown over", async () => {
  const root = siteRoot();
  const file = plant(
    root,
    "b1.json",
    `{"version":${String(MANIFEST_VERSION)}}\n`,
  );

  const listed = await listRetainedManifests(root);
  const warning = await retainManifest(
    root,
    manifest("b2", "2026-08-26T09:30:00.000Z"),
  );

  expect(listed).toEqual([]);
  expect(readdirSync(join(root, RETENTION_DIR))).toEqual(["b2.json"]);
  expect(warning).toContain(
    `Manifest "${file}": 8 fields do not hold what pagedeck build writes there (build: expected an object, found nothing;`,
  );
});

// Skipped on Windows: `STORE_OPEN_FLAGS` has no `O_NOFOLLOW` there, and
// `symlinkSync` needs a privilege.
test.skipIf(process.platform === "win32")(
  "a symlink in the store cannot put the file it points at into a warning",
  async () => {
    const owned = siteRoot();
    const root = join(owned, "site");
    mkdirSync(root, { recursive: true });
    const secret = join(owned, "secret.txt");
    writeFileSync(secret, "leaked-secret-value\n");
    const dir = join(root, RETENTION_DIR);
    mkdirSync(dir, { recursive: true });
    const link = join(dir, "b1.json");
    symlinkSync(secret, link);

    const warning = await retainManifest(
      root,
      manifest("b2", "2026-08-26T09:30:00.000Z"),
    );

    expect(warning).not.toContain("leaked-sec");
    expect(warning).toContain(
      `Retention store: 1 retained manifest could not be read and has been pruned`,
    );
    expect(warning).toContain(link);
    expect(warning).not.toContain(secret);
    expect(existsSync(secret)).toBe(true);
    expect(readdirSync(dir)).toEqual(["b2.json"]);
  },
);

// Skipped on Windows (no `O_NOFOLLOW`). The cause is checked for presence, not for
// its errno, which depends on the host.
test.skipIf(process.platform === "win32")(
  "a symlink named as a rollback target cannot put the file it points at into the refusal",
  async () => {
    const owned = siteRoot();
    const root = join(owned, "site");
    mkdirSync(root, { recursive: true });
    const secret = join(owned, "secret.txt");
    writeFileSync(secret, "leaked-secret-value\n");
    const dir = join(root, RETENTION_DIR);
    mkdirSync(dir, { recursive: true });
    const link = join(dir, "b1.json");
    symlinkSync(secret, link);

    const failure: unknown = await readRetainedManifest(root, "b1").catch(
      (thrown: unknown) => thrown,
    );

    const written = describeError(failure);
    expect(written).not.toContain("leaked-sec");
    expect(written).not.toContain(secret);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(written).toContain(
      `Retained manifest "b1": nothing opened at ${JSON.stringify(link)}`,
    );
    expect((failure as Error).cause).toBeDefined();
    expect(existsSync(secret)).toBe(true);
  },
);

test("a directory where a document should be is refused without being called a link", async () => {
  const root = siteRoot();
  const file = join(root, RETENTION_DIR, "b1.json");
  mkdirSync(file, { recursive: true });

  const failure: unknown = await readRetainedManifest(root, "b1").catch(
    (thrown: unknown) => thrown,
  );

  expect(failure).toBeInstanceOf(ConfigError);
  const written = describeError(failure);
  expect(written).toContain(
    "on a link, on a directory, on a mode that forbids the read, or on a name",
  );
  expect(written).toContain(JSON.stringify(file));
});

test("a failure the store does not classify escapes as it arrived", async () => {
  const root = siteRoot();

  const failure: unknown = await readRetainedManifest(root, "b\u00001").catch(
    (thrown: unknown) => thrown,
  );

  expect(failure).not.toBeInstanceOf(ConfigError);
  expect((failure as NodeJS.ErrnoException).code).toBe("ERR_INVALID_ARG_VALUE");
});
