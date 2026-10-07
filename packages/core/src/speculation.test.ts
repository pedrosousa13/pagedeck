import { expect, test } from "vitest";
import type { Page } from "./pages.js";
import { speculationFaultReport, speculationRules } from "./speculation.js";

const WHERE = 'Config "/site/pagedeck.config.ts"';

function row(page: {
  locale: string;
  path: `/${string}`;
  domain?: string;
  output?: string;
  collection?: string;
  entry?: string;
  fallbackFrom?: string;
  relatesTo?: readonly (readonly [string, string, string])[];
  dependsOn?: readonly (readonly [string, string, string])[];
}): Page {
  const collection = page.collection ?? "pages";
  const entry = page.entry ?? page.path.slice(1);
  const entryLocale = page.fallbackFrom ?? page.locale;
  const refs = (
    named: readonly (readonly [string, string, string])[] | undefined,
  ): { collection: string; locale: string; path: string }[] =>
    (named ?? []).map(([c, locale, path]) => ({
      collection: c,
      locale,
      path,
    }));
  return {
    locale: page.locale,
    path: page.path,
    domain: page.domain,
    output: page.output ?? `/${page.locale}${page.path}`,
    collection,
    entry: { locale: entryLocale, path: entry },
    fallbackFrom: page.fallbackFrom,
    dependencies: [
      { collection, locale: entryLocale, path: entry },
      ...refs(page.dependsOn),
    ],
    relations: page.relatesTo === undefined ? undefined : refs(page.relatesTo),
  };
}

const SETTING = { action: "prefetch", max: 5 } as const;

function rules(
  pages: readonly Page[],
  setting: Parameters<typeof speculationRules>[0]["setting"] = SETTING,
): ReadonlyMap<string, string> {
  return speculationRules({ setting, pages });
}

function documentFor(
  emitted: ReadonlyMap<string, string>,
  key: string,
): unknown {
  const text = emitted.get(key);
  return text === undefined ? undefined : JSON.parse(text);
}

test("a page's targets are the pages its declared relations resolve to", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [["pages", "en", "pricing"]],
    }),
    row({ locale: "en", path: "/pricing" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("a page that declares no relations emits no rules at all", () => {
  const emitted = rules([row({ locale: "en", path: "/home" })]);

  expect(emitted.get("en /home")).toBeUndefined();
});

test("a dependency that is another page is still not a target", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      dependsOn: [["pages", "en", "pricing"]],
      relatesTo: [["pages", "en", "about"]],
    }),
    row({ locale: "en", path: "/pricing" }),
    row({ locale: "en", path: "/about" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/about"] }],
  });
});

test("a relation that is no page's own entry drops out of the join", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [
        ["globals", "en", "nav"],
        ["pages", "en", "pricing"],
      ],
    }),
    row({ locale: "en", path: "/pricing" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("the collection is part of the join, so two collections do not collide", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [["posts", "en", "pricing"]],
    }),
    row({ locale: "en", path: "/pricing", collection: "pages" }),
  ]);

  expect(emitted.get("en /home")).toBeUndefined();
});

test("targets keep the order the page declared them in, capped at max", () => {
  const emitted = rules(
    [
      row({
        locale: "en",
        path: "/home",
        relatesTo: [
          ["pages", "en", "d"],
          ["pages", "en", "c"],
          ["pages", "en", "b"],
        ],
      }),
      row({ locale: "en", path: "/d" }),
      row({ locale: "en", path: "/c" }),
      row({ locale: "en", path: "/b" }),
    ],
    { action: "prefetch", max: 2 },
  );

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/d", "/en/c"] }],
  });
});

test("a target in another output tree is not listed", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [
        ["pages", "de", "impressum"],
        ["pages", "en", "pricing"],
      ],
    }),
    row({
      locale: "de",
      path: "/impressum",
      domain: "example.de",
      output: "/impressum",
    }),
    row({ locale: "en", path: "/pricing" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("a page never speculates itself, however it reached its own row", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [
        ["pages", "en", "home"],
        ["pages", "en", "pricing"],
      ],
    }),
    row({ locale: "en", path: "/pricing" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("two relations onto one page are listed once", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [
        ["pages", "en", "pricing"],
        ["pages", "en", "pricing"],
      ],
    }),
    row({ locale: "en", path: "/pricing" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("the action the site declared is the key of the rules document", () => {
  const emitted = rules(
    [
      row({
        locale: "en",
        path: "/home",
        relatesTo: [["pages", "en", "pricing"]],
      }),
      row({ locale: "en", path: "/pricing" }),
    ],
    { action: "prerender", max: 5 },
  );

  expect(documentFor(emitted, "en /home")).toEqual({
    prerender: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("a page with no own entry is neither a source nor a target", () => {
  const composed: Page = {
    locale: "en",
    path: "/composed",
    output: "/en/composed",
    dependencies: [],
    relations: [{ collection: "pages", locale: "en", path: "home" }],
  };
  const emitted = rules([
    composed,
    row({
      locale: "en",
      path: "/home",
      relatesTo: [["pages", "en", "composed"]],
    }),
  ]);

  expect(documentFor(emitted, "en /composed")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/home"] }],
  });
  expect(emitted.get("en /home")).toBeUndefined();
});

test("a fallback page never stands in for the entry it serves", () => {
  const emitted = rules([
    row({
      locale: "en",
      path: "/home",
      relatesTo: [["pages", "en", "pricing"]],
    }),
    row({ locale: "en", path: "/pricing" }),
    row({ locale: "fr", path: "/pricing", fallbackFrom: "en" }),
  ]);

  expect(documentFor(emitted, "en /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("a fallback page is still a source, from the relations it carries", () => {
  const emitted = rules([
    row({ locale: "en", path: "/pricing" }),
    row({
      locale: "fr",
      path: "/home",
      fallbackFrom: "en",
      relatesTo: [["pages", "en", "pricing"]],
    }),
  ]);

  expect(documentFor(emitted, "fr /home")).toEqual({
    prefetch: [{ source: "list", urls: ["/en/pricing"] }],
  });
});

test("a setting that is not an object is refused on its own", () => {
  expect(speculationFaultReport("prefetch", WHERE)).toBe(
    `${WHERE}: "build.speculation" must be an object naming the action its rules take and how many pages one may list — speculation: { action: "prefetch", max: 5 }`,
  );
});

test("every unusable field is reported, each with the type its line names", () => {
  expect(speculationFaultReport({ action: "preload", max: 0 }, WHERE)).toBe(
    `${WHERE}: "build.speculation" declares 2 fields this build cannot emit speculation rules from — declare each as the type its own line names:
  "action" — "preload" — not a speculation action — write "prefetch" to fetch the next page's bytes, or "prerender" to render it
  "max" — 0 — not a whole number of pages above zero — write the most pages one document may list, such as max: 5`,
  );
});

test("a valid setting is no fault", () => {
  expect(speculationFaultReport({ action: "prerender", max: 1 }, WHERE)).toBe(
    undefined,
  );
  expect(speculationFaultReport({ action: "prefetch", max: 5 }, WHERE)).toBe(
    undefined,
  );
});

test("a fractional max is refused, because a cap is a count of pages", () => {
  expect(speculationFaultReport({ action: "prefetch", max: 2.5 }, WHERE)).toBe(
    `${WHERE}: "build.speculation" declares 1 field this build cannot emit speculation rules from — declare each as the type its own line names:
  "max" — 2.5 — not a whole number of pages above zero — write the most pages one document may list, such as max: 5`,
  );
});
