import { expect, test } from "vitest";
import type { LocaleSet } from "./locales.js";
import type { EmittedFile } from "./manifest.js";
import { robotsFaultReport, robotsFiles } from "./robots.js";

const ORIGIN = "https://example.com";

const SETTING = {};

function localeSet(...domains: readonly (string | undefined)[]): LocaleSet {
  return new Map(
    domains.map((domain, index) => {
      const code = `l${String(index)}`;
      return [
        code,
        {
          code,
          label: code,
          direction: "ltr" as const,
          prefix: "",
          ...(domain === undefined ? {} : { domain }),
        },
      ];
    }),
  );
}

const DEFAULT_TREE = localeSet(undefined);

function keys(files: readonly EmittedFile[]): readonly string[] {
  return files.map((file) =>
    file.domain === undefined ? file.path : `//${file.domain}${file.path}`,
  );
}

function text(file: EmittedFile | undefined): string {
  return typeof file?.contents === "string" ? file.contents : "";
}

test("a robots setting that is not an object is refused with the shape as the fix", () => {
  expect(robotsFaultReport(true, "Config")).toBe(
    'Config: "build.robots" must be an object holding the directives the site adds — robots: { disallow: ["/admin"] }',
  );
});

test("a declaration with no directives at all reports nothing", () => {
  expect(robotsFaultReport(SETTING, "Config")).toBe(undefined);
});

test("a disallow that is not a list is refused, naming the field and the fix", () => {
  expect(robotsFaultReport({ disallow: "/admin" }, "Config")).toBe(
    'Config: "build.robots" declares 1 field this build cannot write a robots.txt from — declare each as the type its own line names:\n  "disallow" — "/admin" — not a list of paths — list the paths crawlers must not fetch — disallow: ["/admin"]',
  );
});

test("a path that does not start with a slash is refused, naming its position", () => {
  expect(robotsFaultReport({ allow: ["/ok", "admin"] }, "Config")).toBe(
    'Config: "build.robots" declares 1 field this build cannot write a robots.txt from — declare each as the type its own line names:\n  "allow[1]" — "admin" — not a path a robots.txt rule can hold — write the path a crawler would request, starting at the root, with any space percent-encoded as %20 — allow: ["/admin"]',
  );
});

test("a path holding whitespace is refused, because a directive ends at its line", () => {
  const report = robotsFaultReport({ disallow: ["/a\nDisallow: /"] }, "Config");

  expect(report).toContain('"disallow[0]"');
  expect(report).toContain("not a path a robots.txt rule can hold");
  expect(report).toContain("percent-encoded as %20");
});

test("both lists are reported at once, and each bad entry gets its own line", () => {
  const report = robotsFaultReport(
    { disallow: ["admin", "/ok"], allow: [3] },
    "Config",
  );

  expect(report).toContain('"build.robots" declares 2 fields');
  expect(report).toContain('"disallow[0]" — "admin"');
  expect(report).toContain('"allow[0]" — 3');
});

test("a verbatim list that is not a list is refused, naming the field and the fix", () => {
  expect(
    robotsFaultReport({ verbatim: "User-agent: example-bot" }, "Config"),
  ).toBe(
    'Config: "build.robots" declares 1 field this build cannot write a robots.txt from — declare each as the type its own line names:\n  "verbatim" — "User-agent: example-bot" — not a list of lines — list the lines to write above the group, one string per line — verbatim: ["User-agent: example-bot", "Disallow: /drafts"]',
  );
});

test("a verbatim entry that is not text is refused, naming its position", () => {
  expect(
    robotsFaultReport({ verbatim: ["User-agent: example-bot", 3] }, "Config"),
  ).toBe(
    'Config: "build.robots" declares 1 field this build cannot write a robots.txt from — declare each as the type its own line names:\n  "verbatim[1]" — 3 — not a line a robots.txt can hold — write each entry as the text of one line, which this build writes into the file unread — verbatim: ["User-agent: example-bot", "Disallow: /drafts"]',
  );
});

test("a blank verbatim line is carried into the file, spacing and all", () => {
  const setting = { verbatim: ["User-agent: example-bot", "", "# a note"] };

  expect(robotsFaultReport(setting, "Config")).toBe(undefined);
  expect(
    text(
      robotsFiles({
        setting,
        origin: ORIGIN,
        sitemaps: false,
        locales: DEFAULT_TREE,
        emitted: [],
      })[0],
    ),
  ).toBe("User-agent: example-bot\n\n# a note\n");
});

test("an inherited disallow is not a declaration", () => {
  expect(
    robotsFaultReport(Object.create({ disallow: ["admin"] }), "Config"),
  ).toBe(undefined);
});

test("the robots.txt points at the sitemap this build wrote, at its absolute URL", () => {
  const files = robotsFiles({
    setting: SETTING,
    origin: ORIGIN,
    sitemaps: true,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(keys(files)).toEqual(["/robots.txt"]);
  expect(files[0]?.kind).toBe("asset");
  expect(text(files[0])).toBe("Sitemap: https://example.com/sitemap.xml\n");
});

test("a site that declared no sitemap gets no Sitemap line to a file nothing wrote", () => {
  const files = robotsFiles({
    setting: SETTING,
    origin: ORIGIN,
    sitemaps: false,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(text(files[0])).toBe("");
});

test("a site with no origin gets its own directives and no Sitemap line", () => {
  const files = robotsFiles({
    setting: { disallow: ["/admin"] },
    origin: undefined,
    sitemaps: false,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(keys(files)).toEqual(["/robots.txt"]);
  expect(text(files[0])).toBe("User-agent: *\nDisallow: /admin\n");
});

test("the site's own directives are one group, disallow first and in declared order", () => {
  const files = robotsFiles({
    setting: { disallow: ["/admin", "/drafts"], allow: ["/admin/public"] },
    origin: ORIGIN,
    sitemaps: true,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(text(files[0])).toBe(
    `User-agent: *
Disallow: /admin
Disallow: /drafts
Allow: /admin/public

Sitemap: https://example.com/sitemap.xml
`,
  );
});

test("the site's own lines are written above the group, and above the Sitemap line", () => {
  const files = robotsFiles({
    setting: {
      verbatim: [
        "User-agent: example-bot",
        "Disallow: /drafts",
        "",
        "# a note",
      ],
      disallow: ["/admin"],
      allow: ["/"],
    },
    origin: ORIGIN,
    sitemaps: true,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(text(files[0])).toBe(
    `User-agent: example-bot
Disallow: /drafts

# a note

User-agent: *
Disallow: /admin
Allow: /

Sitemap: https://example.com/sitemap.xml
`,
  );
});

test("a site that declares only its own lines is written those lines and nothing else", () => {
  const files = robotsFiles({
    setting: { verbatim: ["User-agent: example-bot", "Disallow: /drafts"] },
    origin: undefined,
    sitemaps: false,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(text(files[0])).toBe("User-agent: example-bot\nDisallow: /drafts\n");
});

test("a block ending on a bare user-agent line takes the composed group into it", () => {
  const files = robotsFiles({
    setting: { verbatim: ["User-agent: example-bot"], disallow: ["/admin"] },
    origin: ORIGIN,
    sitemaps: false,
    locales: DEFAULT_TREE,
    emitted: [],
  });

  expect(text(files[0])).toBe(
    `User-agent: example-bot

User-agent: *
Disallow: /admin
`,
  );
});

test("every output tree gets a robots.txt naming its own tree's sitemap", () => {
  const files = robotsFiles({
    setting: SETTING,
    origin: ORIGIN,
    sitemaps: true,
    locales: localeSet("example.de", undefined, "example.fr", "example.de"),
    emitted: [],
  });

  expect(keys(files)).toEqual([
    "/robots.txt",
    "//example.de/robots.txt",
    "//example.fr/robots.txt",
  ]);
  expect(files.map((file) => text(file))).toEqual([
    "Sitemap: https://example.com/sitemap.xml\n",
    "Sitemap: https://example.de/sitemap.xml\n",
    "Sitemap: https://example.fr/sitemap.xml\n",
  ]);
});

test("two spellings of one host get one robots.txt, in the tree the parsed host keys", () => {
  const files = robotsFiles({
    setting: SETTING,
    origin: ORIGIN,
    sitemaps: true,
    locales: localeSet("münchen.de", "xn--mnchen-3ya.de"),
    emitted: [],
  });

  expect(keys(files)).toEqual(["//xn--mnchen-3ya.de/robots.txt"]);
  expect(files.map((file) => text(file))).toEqual([
    "Sitemap: https://münchen.de/sitemap.xml\n",
  ]);
});

test("which spelling a tree's Sitemap line uses does not depend on declaration order", () => {
  const de = {
    code: "de",
    label: "de",
    direction: "ltr" as const,
    prefix: "/de",
    domain: "münchen.de",
  };
  const at = {
    code: "de-AT",
    label: "de-AT",
    direction: "ltr" as const,
    prefix: "/de-AT",
    domain: "xn--mnchen-3ya.de",
  };
  const written = (locales: LocaleSet): readonly string[] =>
    robotsFiles({
      setting: SETTING,
      origin: ORIGIN,
      sitemaps: true,
      locales,
      emitted: [],
    }).map((file) => text(file));

  const forward = written(new Map([["de", de], ["de-AT", at]]));
  const reversed = written(new Map([["de-AT", at], ["de", de]]));
  expect(forward).toEqual(["Sitemap: https://münchen.de/sitemap.xml\n"]);
  expect(reversed).toEqual(forward);
});

test("a robots.txt at a deploy key this build already wrote is refused, naming every colliding key", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/robots.txt", kind: "html", contents: "" },
    { domain: "example.de", path: "/robots.txt", kind: "asset", contents: "" },
  ];

  expect(() =>
    robotsFiles({
      setting: SETTING,
      origin: ORIGIN,
      sitemaps: true,
      locales: localeSet(undefined, "example.de"),
      emitted,
    }),
  ).toThrow(
    'Robots: 2 files are at a deploy key this build already wrote — a deploy key holds one file, and the site\'s own pages, chunks and assets are written before the robots.txt is; move the page off that address:\n  "//example.de/robots.txt" — the build already emitted an asset file there\n  "/robots.txt" — the build already emitted an html file there',
  );
});
