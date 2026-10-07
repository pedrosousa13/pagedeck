import { expect, test } from "vitest";
import {
  DEFAULT_PRUNE_POLICY,
  DIFF_VERSION,
  diffJson,
  diffManifests,
  racedDeployReport,
} from "./diff.js";
import { ConfigError } from "./exit.js";
import { buildManifest } from "./manifest.js";
import type {
  BuildStamp,
  EmittedFile,
  Manifest,
  ManifestFile,
} from "./manifest.js";
import type { Page } from "./pages.js";
import { planEntries } from "./entries.js";
import { planRouting } from "./routing.js";
import { planTiers } from "./tiers.js";

const FROM_STAMP: BuildStamp = {
  id: "build-2026-08-25-01",
  createdAt: "2026-08-25T10:00:00.000Z",
};

const TO_STAMP: BuildStamp = {
  id: "build-2026-08-26-01",
  createdAt: "2026-08-26T09:30:00.000Z",
};

const HOME: Page = {
  locale: "en",
  path: "/",
  output: "/en",
  dependencies: [],
};

const ABOUT: Page = {
  locale: "en",
  path: "/about",
  output: "/en/about",
  dependencies: [],
};

function manifestOf(
  outputs: readonly EmittedFile[],
  options: { stamp?: BuildStamp; pages?: readonly Page[] } = {},
): Manifest {
  const pages = options.pages ?? [HOME, ABOUT];
  const entries = planEntries(
    pages.map((page) => ({ page, islands: [] })),
    { modules: {} },
  );
  return buildManifest({
    build: options.stamp ?? FROM_STAMP,
    store: { seq: 512 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages, trailingSlash: "never" }),
    pages,
    entries,
    tiers: planTiers({ entries: entries.entries, ranking: [] }),
    classes: [],
    foldTuning: new Map(),
    outputs,
  });
}

const FROM_OUTPUTS: readonly EmittedFile[] = [
  {
    path: "/en/index.html",
    kind: "html",
    page: { locale: "en", path: "/" },
    contents: "<!doctype html><title>Home</title>",
  },
  {
    path: "/en/about/index.html",
    kind: "html",
    page: { locale: "en", path: "/about" },
    contents: "<!doctype html><title>About</title>",
  },
  { path: "/assets/en-a1b2c3.js", kind: "js", contents: "export const a = 1;" },
  { path: "/assets/core-1a2b3c.css", kind: "css", contents: ".a{color:red}" },
  {
    path: "/media/logo-7f8e9d.svg",
    kind: "asset",
    contents: new Uint8Array([60, 115, 118, 103, 47, 62]),
  },
];

const TO_OUTPUTS: readonly EmittedFile[] = [
  {
    path: "/en/index.html",
    kind: "html",
    page: { locale: "en", path: "/" },
    contents: "<!doctype html><title>Home, revised</title>",
  },
  {
    path: "/en/about/index.html",
    kind: "html",
    page: { locale: "en", path: "/about" },
    contents: "<!doctype html><title>About</title>",
  },
  { path: "/assets/en-d4e5f6.js", kind: "js", contents: "export const a = 2;" },
  { path: "/assets/core-1a2b3c.css", kind: "css", contents: ".a{color:blue}" },
  {
    path: "/media/logo-7f8e9d.svg",
    kind: "asset",
    contents: new Uint8Array([60, 115, 118, 103, 32, 47, 62]),
  },
];

const FROM = manifestOf(FROM_OUTPUTS);
const TO = manifestOf(TO_OUTPUTS, { stamp: TO_STAMP });

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, but it returned");
}

test("the diff names what to add, what changed and what to prune", () => {
  const diff = diffManifests({ from: FROM, to: TO });
  const [tree] = diff.trees;

  expect(diff.version).toBe(DIFF_VERSION);
  expect(diff.from).toEqual(FROM_STAMP);
  expect(diff.to).toEqual(TO_STAMP);

  expect(
    tree?.upload.map((file) => [file.change, file.key, file.kind]),
  ).toEqual([
    ["changed", "/assets/core-1a2b3c.css", "css"],
    ["added", "/assets/en-d4e5f6.js", "js"],
    ["changed", "/media/logo-7f8e9d.svg", "asset"],
    ["changed", "/en/index.html", "html"],
  ]);
  expect(tree?.prune.map((file) => file.key)).toEqual([
    "/assets/en-a1b2c3.js",
  ]);
});

test("a changed upload carries the hash the host is serving today", () => {
  const diff = diffManifests({ from: FROM, to: TO });
  const home = diff.trees[0]?.upload.find(
    (file) => file.key === "/en/index.html",
  );
  const before = FROM.files.find((file) => file.path === "/en/index.html");
  const after = TO.files.find((file) => file.path === "/en/index.html");

  expect(home?.hash).toBe(after?.hash);
  expect(home?.previousHash).toBe(before?.hash);
  expect(
    diff.trees[0]?.upload.find((file) => file.key === "/assets/en-d4e5f6.js")
      ?.previousHash,
  ).toBeUndefined();
});

test("an upload carries hashed when the build it deploys recorded it, and the document spells it (#560)", () => {
  const to = manifestOf(
    TO_OUTPUTS.map((file) => (file.kind === "js" ? { ...file, hashed: true as const } : file)),
    { stamp: TO_STAMP },
  );
  const diff = diffManifests({ from: FROM, to });
  const rows = diff.trees.flatMap((tree) => tree.upload);
  expect(rows.filter((row) => row.hashed === true).map((row) => row.path)).toEqual([
    "/assets/en-d4e5f6.js",
  ]);
  for (const row of rows) if (row.kind !== "js") expect(Object.hasOwn(row, "hashed")).toBe(false);
  const document = diffJson(diff);
  expect(document).toContain(`"size": 19,\n          "hashed": true\n`);
  expect(document.match(/"hashed"/g)).toHaveLength(1);
});

test("every upload that is not HTML comes before every HTML upload", () => {
  const uploads = diffManifests({ from: FROM, to: TO }).trees[0]?.upload ?? [];
  const firstHtml = uploads.findIndex((file) => file.kind === "html");
  const lastAsset = uploads.reduce(
    (last, file, index) => (file.kind === "html" ? last : index),
    -1,
  );
  expect(firstHtml).toBeGreaterThan(lastAsset);
});

test("the prune list is a separate array with the grace period on it", () => {
  const diff = diffManifests({ from: FROM, to: TO });
  const pruned = diff.trees[0]?.prune[0];
  const before = FROM.files.find(
    (file) => file.path === "/assets/en-a1b2c3.js",
  );

  expect(pruned?.hash).toBe(before?.hash);
  expect(pruned?.size).toBe(before?.size);

  expect(diff.prune.graceSeconds).toBe(DEFAULT_PRUNE_POLICY.graceSeconds);
  expect(diff.prune.after).toBe(TO_STAMP.createdAt);
  expect(diff.prune.notBefore).toBe("2026-09-02T09:30:00.000Z");
});

test("a caller's own grace period moves the deadline and nothing else", () => {
  const diff = diffManifests({
    from: FROM,
    to: TO,
    prune: { graceSeconds: 3600 },
  });
  expect(diff.prune.graceSeconds).toBe(3600);
  expect(diff.prune.notBefore).toBe("2026-08-26T10:30:00.000Z");
  expect(diff.trees[0]?.prune.map((file) => file.key)).toEqual([
    "/assets/en-a1b2c3.js",
  ]);
});

test("a file both builds emit at one hash appears in no list", () => {
  const diff = diffManifests({ from: FROM, to: TO });
  const named = [
    ...diff.trees.flatMap((tree) => tree.upload.map((file) => file.key)),
    ...diff.trees.flatMap((tree) => tree.prune.map((file) => file.key)),
  ];
  expect(named).not.toContain("/en/about/index.html");
  expect(diff.stats).toEqual({
    added: 1,
    changed: 3,
    pruned: 1,
    unchanged: 1,
    uploadBytes: 14 + 19 + 7 + 43,
    prunedBytes: 19,
  });
});

test("a build diffed against itself is empty and says how much it skipped", () => {
  const diff = diffManifests({ from: TO, to: TO });
  expect(diff.trees).toEqual([{ upload: [], prune: [] }]);
  expect(diff.stats).toEqual({
    added: 0,
    changed: 0,
    pruned: 0,
    unchanged: TO.files.length,
    uploadBytes: 0,
    prunedBytes: 0,
  });
});

test("a build that followed the one it deploys over is reported as no race", () => {
  expect(
    racedDeployReport(
      diffManifests({
        from: FROM,
        to: { ...TO, build: { ...TO_STAMP, parent: FROM_STAMP.id } },
      }),
    ),
  ).toBeUndefined();
});

test("a build based on neither side is reported as a race, naming both builds", () => {
  const report = racedDeployReport(
    diffManifests({
      from: FROM,
      to: { ...TO, build: { ...TO_STAMP, parent: "build-99" } },
    }),
  );

  expect(report).toContain(TO_STAMP.id);
  expect(report).toContain("build-99");
  expect(report).toContain(FROM_STAMP.id);
  expect(report).toContain("--force");
});

test("a build that records no parent gets its own sentence", () => {
  expect(racedDeployReport(diffManifests({ from: FROM, to: TO }))).toContain(
    "records no parent",
  );
});

test("a deploy that names no file is exempt, whatever the two stamps say", () => {
  expect(racedDeployReport(diffManifests({ from: TO, to: TO }))).toBeUndefined();
});

test("two builds stamped with one id and different content are refused", () => {
  const report = racedDeployReport(
    diffManifests({
      from: FROM,
      to: manifestOf(TO_OUTPUTS, {
        stamp: { ...FROM_STAMP, parent: "build-99" },
      }),
    }),
  );

  expect(report).toContain("build-99");
  expect(report).toContain("--force");
});

test("a build id that could forge a line reaches the raced-deploy report quoted", () => {
  const forge = (name: string): string =>
    `${name}"\n\u001B[Kfw: Site build: 0 problems\r`;
  const raced = racedDeployReport(
    diffManifests({
      from: manifestOf(FROM_OUTPUTS, {
        stamp: { ...FROM_STAMP, id: forge("from") },
      }),
      to: manifestOf(TO_OUTPUTS, {
        stamp: { ...TO_STAMP, id: forge("to"), parent: forge("parent") },
      }),
    }),
  );
  const unparented = racedDeployReport(
    diffManifests({
      from: manifestOf(FROM_OUTPUTS, {
        stamp: { ...FROM_STAMP, id: forge("from") },
      }),
      to: manifestOf(TO_OUTPUTS, { stamp: { ...TO_STAMP, id: forge("to") } }),
    }),
  );

  expect(raced?.split("\n")).toHaveLength(1);
  expect(unparented?.split("\n")).toHaveLength(1);
  for (const name of ["from", "to", "parent"])
    expect(raced).toContain(JSON.stringify(forge(name)));
  for (const name of ["from", "to"])
    expect(unparented).toContain(JSON.stringify(forge(name)));
});

test("a build id a CI wrapper minted is named whole in the raced-deploy report", () => {
  const raced = racedDeployReport(
    diffManifests({
      from: manifestOf(FROM_OUTPUTS, {
        stamp: { ...FROM_STAMP, id: "release#41" },
      }),
      to: manifestOf(TO_OUTPUTS, {
        stamp: { ...TO_STAMP, id: "main@9e1f4a02", parent: "hotfix@0b2c1d3" },
      }),
    }),
  );

  expect(raced).toContain('build "main@9e1f4a02"');
  expect(raced).toContain('built on "hotfix@0b2c1d3"');
  expect(raced).toContain('build "release#41"');
  expect(raced).not.toContain("…");
});

const DE: Page = {
  locale: "de",
  path: "/preise",
  domain: "de.example",
  output: "/preise",
  dependencies: [],
};

function twoDomainOutputs(
  home: string,
  preise: string,
): readonly EmittedFile[] {
  return [
    {
      path: "/en/index.html",
      kind: "html",
      page: { locale: "en", path: "/" },
      contents: home,
    },
    { path: "/assets/en-a1b2c3.js", kind: "js", contents: "export const a=1;" },
    {
      domain: "de.example",
      path: "/preise/index.html",
      kind: "html",
      page: { locale: "de", path: "/preise" },
      contents: preise,
    },
    {
      domain: "de.example",
      path: "/assets/de-a1b2c3.js",
      kind: "js",
      contents: "export const a=1;",
    },
  ];
}

test("each output tree is grouped on its own, the default tree first", () => {
  const pages = [DE, HOME];
  const from = manifestOf(twoDomainOutputs("<p>home</p>", "<p>preise</p>"), {
    pages,
  });
  const to = manifestOf(
    twoDomainOutputs("<p>home, revised</p>", "<p>preise</p>"),
    { pages, stamp: TO_STAMP },
  );
  const diff = diffManifests({ from, to });

  expect(diff.trees.map((tree) => tree.domain)).toEqual([
    undefined,
    "de.example",
  ]);
  expect(diff.trees[0]?.upload.map((file) => file.key)).toEqual([
    "/en/index.html",
  ]);
  expect(diff.trees[1]?.upload).toEqual([]);
  expect(diff.trees[1]?.prune).toEqual([]);
  expect(diff.trees[1]?.domain).toBe("de.example");
});

test("a tree the target build dropped still gets one, holding only prune rows", () => {
  const from = manifestOf(twoDomainOutputs("<p>home</p>", "<p>preise</p>"), {
    pages: [DE, HOME],
  });
  const to = manifestOf(
    [
      {
        path: "/en/index.html",
        kind: "html",
        page: { locale: "en", path: "/" },
        contents: "<p>home</p>",
      },
      {
        path: "/assets/en-a1b2c3.js",
        kind: "js",
        contents: "export const a=1;",
      },
    ],
    { pages: [HOME], stamp: TO_STAMP },
  );
  const diff = diffManifests({ from, to });

  expect(diff.trees.map((tree) => tree.domain)).toEqual([
    undefined,
    "de.example",
  ]);
  expect(diff.trees[1]?.upload).toEqual([]);
  expect(diff.trees[1]?.prune.map((file) => file.key)).toEqual([
    "//de.example/assets/de-a1b2c3.js",
    "//de.example/preise/index.html",
  ]);
});

test("a tree one build spells as an empty domain keeps its files", () => {
  const to: Manifest = {
    ...TO,
    files: TO.files.map((file) => ({ ...file, domain: "" })),
  };
  const diff = diffManifests({ from: FROM, to });
  const uploaded = diff.trees.flatMap((tree) =>
    tree.upload.map((file) => file.key),
  );
  const pruned = diff.trees.flatMap((tree) =>
    tree.prune.map((file) => file.key),
  );

  expect(uploaded).toHaveLength(diff.stats.added + diff.stats.changed);
  expect(pruned).toHaveLength(diff.stats.pruned);
});

test("an empty domain joins against an absent one, rather than against nothing", () => {
  const to: Manifest = {
    ...TO,
    files: TO.files.map((file) => ({ ...file, domain: "" })),
  };

  expect(diffManifests({ from: FROM, to })).toEqual(
    diffManifests({ from: FROM, to: TO }),
  );
});

test("a manifest whose files are not in sorted order gets one tree per domain", () => {
  const sorted = manifestOf(twoDomainOutputs("<p>home</p>", "<p>preise</p>"), {
    pages: [DE, HOME],
  });
  const interleave = (files: readonly ManifestFile[]): ManifestFile[] =>
    [0, 2, 1, 3].map((index) => files[index] as ManifestFile);
  const from: Manifest = { ...sorted, files: interleave(sorted.files) };
  const revised = manifestOf(
    twoDomainOutputs("<p>home, revised</p>", "<p>preise</p>"),
    { pages: [DE, HOME], stamp: TO_STAMP },
  );
  const to: Manifest = { ...revised, files: interleave(revised.files) };
  const diff = diffManifests({ from, to });

  expect(diff.trees.map((tree) => tree.domain)).toEqual([
    undefined,
    "de.example",
  ]);
  const uploaded = diff.trees.flatMap((tree) =>
    tree.upload.map((file) => file.key),
  );
  expect(uploaded).toEqual(["/en/index.html"]);
});

test("a build timestamp with no UTC offset is refused, not read in local time", () => {
  // `Date.parse` of an offset-less timestamp resolves in the runner's own timezone, so two
  // runners would derive two `notBefore` values (#20).
  const message = failureOf(() =>
    diffManifests({
      from: FROM,
      to: { ...TO, build: { ...TO_STAMP, createdAt: "2026-08-26T09:30:00" } },
    }),
  ).message;
  expect(message).toBe(
    'Manifest diff: the to manifest\'s build.createdAt is "2026-08-26T09:30:00", which carries no UTC offset, so the prune deadline it derives would move with the machine\'s timezone — pagedeck build writes an ISO-8601 timestamp in UTC, so re-run the build that wrote this manifest',
  );
});

test("a grace period no deadline can be expressed as is refused as wiring", () => {
  const error = failureOf(() =>
    diffManifests({ from: FROM, to: TO, prune: { graceSeconds: 9e12 } }),
  );
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    'Manifest diff: a grace period of 9000000000000 seconds past "2026-08-26T09:30:00.000Z" is not a deadline any date can hold — pass a smaller --grace-seconds (the default is 604800, seven days)',
  );
});

test("two runs over two documents write the same bytes", () => {
  expect(diffJson(diffManifests({ from: FROM, to: TO }))).toBe(
    diffJson(diffManifests({ from: FROM, to: TO })),
  );
});

test("a deploy key a manifest holds twice is refused, naming every one", () => {
  const doubled = {
    ...FROM,
    files: [...FROM.files, FROM.files[0] as (typeof FROM.files)[number]],
  };
  const doubledTo = { ...TO, files: [...TO.files, ...TO.files] };
  const message = failureOf(() =>
    diffManifests({ from: doubled, to: doubledTo }),
  ).message;
  expect(message).toContain("Manifest diff:");
  expect(message).toContain('"/assets/core-1a2b3c.css" — in the from manifest');
  expect(message).toContain('"/en/index.html" — in the to manifest');
});

test("a build timestamp no deadline can be derived from is refused", () => {
  const message = failureOf(() =>
    diffManifests({
      from: FROM,
      to: { ...TO, build: { ...TO_STAMP, createdAt: "last tuesday" } },
    }),
  ).message;
  expect(message).toBe(
    'Manifest diff: the to manifest\'s build.createdAt is "last tuesday", which is not a date the prune deadline can be derived from — pagedeck build writes an ISO-8601 timestamp, so re-run the build that wrote this manifest',
  );
});

test("each stamp reaches the document with the base its build recorded", () => {
  const diff = diffManifests({
    from: { ...FROM, build: { ...FROM_STAMP, parent: "build-2026-08-24-01" } },
    to: { ...TO, build: { ...TO_STAMP, parent: FROM_STAMP.id } },
  });

  expect(diff.version).toBe(DIFF_VERSION);
  expect(diffJson(diff)).toContain(
    [
      `  "from": {`,
      `    "id": "build-2026-08-25-01",`,
      `    "createdAt": "2026-08-25T10:00:00.000Z",`,
      `    "parent": "build-2026-08-24-01"`,
      `  },`,
      `  "to": {`,
      `    "id": "build-2026-08-26-01",`,
      `    "createdAt": "2026-08-26T09:30:00.000Z",`,
      `    "parent": "build-2026-08-25-01"`,
      `  },`,
    ].join("\n"),
  );
});

test("the diff serializes to the golden shape", () => {
  expect(diffJson(diffManifests({ from: FROM, to: TO }))).toBe(
    [
      "{",
      `  "version": 1,`,
      `  "from": {`,
      `    "id": "build-2026-08-25-01",`,
      `    "createdAt": "2026-08-25T10:00:00.000Z"`,
      `  },`,
      `  "to": {`,
      `    "id": "build-2026-08-26-01",`,
      `    "createdAt": "2026-08-26T09:30:00.000Z"`,
      `  },`,
      `  "prune": {`,
      `    "graceSeconds": 604800,`,
      `    "after": "2026-08-26T09:30:00.000Z",`,
      `    "notBefore": "2026-09-02T09:30:00.000Z"`,
      `  },`,
      `  "trees": [`,
      `    {`,
      `      "upload": [`,
      `        {`,
      `          "key": "/assets/core-1a2b3c.css",`,
      `          "path": "/assets/core-1a2b3c.css",`,
      `          "kind": "css",`,
      `          "change": "changed",`,
      `          "hash": "sha256:8d5c94c29085e25b97339daaa3920bcfe9b15beb526834d7221e19176f6ee599",`,
      `          "size": 14,`,
      `          "previousHash": "sha256:018915ff051a5c4cf58bda6774dd6f7885c51d95454e3e0e8dc7b6acc2bb6d27"`,
      `        },`,
      `        {`,
      `          "key": "/assets/en-d4e5f6.js",`,
      `          "path": "/assets/en-d4e5f6.js",`,
      `          "kind": "js",`,
      `          "change": "added",`,
      `          "hash": "sha256:5a6dd7e65a616192a3041e7e493907a6056473b716eb178ca7194db89fef125a",`,
      `          "size": 19`,
      `        },`,
      `        {`,
      `          "key": "/media/logo-7f8e9d.svg",`,
      `          "path": "/media/logo-7f8e9d.svg",`,
      `          "kind": "asset",`,
      `          "change": "changed",`,
      `          "hash": "sha256:f68e724d27d8f77658c3fefb57fba1f236c3f0592e66bfbaac3547ffdcdadc8b",`,
      `          "size": 7,`,
      `          "previousHash": "sha256:d4dc56669143034f31aa309635d4113d9ad76a02b1739da22c965ed2049be9e6"`,
      `        },`,
      `        {`,
      `          "key": "/en/index.html",`,
      `          "path": "/en/index.html",`,
      `          "kind": "html",`,
      `          "change": "changed",`,
      `          "hash": "sha256:7c5b831804f992b7abdf36ef2b752c10b06c25dbb06b48daee953b0939d1a476",`,
      `          "size": 43,`,
      `          "previousHash": "sha256:7ee4143a47c59fa2b1f79d25a12c269f433622af257b724fa70a5595f2dce8b3"`,
      `        }`,
      `      ],`,
      `      "prune": [`,
      `        {`,
      `          "key": "/assets/en-a1b2c3.js",`,
      `          "path": "/assets/en-a1b2c3.js",`,
      `          "kind": "js",`,
      `          "hash": "sha256:683314ed22112e8dea8095c8c6173afa2c61279f5fe07968ebe0e21fff16871d",`,
      `          "size": 19`,
      `        }`,
      `      ]`,
      `    }`,
      `  ],`,
      `  "stats": {`,
      `    "added": 1,`,
      `    "changed": 3,`,
      `    "pruned": 1,`,
      `    "unchanged": 1,`,
      `    "uploadBytes": 83,`,
      `    "prunedBytes": 19`,
      `  }`,
      "}",
      "",
    ].join("\n"),
  );
});

test("a forced diff records that the check was skipped, and an unforced one carries no such key", () => {
  const diff = diffManifests({ from: FROM, to: TO });

  expect(diffJson(diff, { forced: true }).split("\n").slice(0, 3)).toEqual([
    "{",
    `  "version": 1,`,
    `  "forced": true,`,
  ]);
  expect(JSON.parse(diffJson(diff))).not.toHaveProperty("forced");
  expect(diffJson(diff)).not.toContain("forced");
});

test("a forced diff writes every key an unforced one writes, in the same order", () => {
  const diff = diffManifests({ from: FROM, to: TO });

  expect(diffJson(diff, { forced: true })).not.toBe(diffJson(diff));
  expect(
    diffJson(diff, { forced: true })
      .split("\n")
      .filter((line) => line !== `  "forced": true,`)
      .join("\n"),
  ).toBe(diffJson(diff));
});
