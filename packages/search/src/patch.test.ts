import { expect, test } from "vitest";
import { ConfigError, searchPatchFaults } from "@pagedeck/core";
import type { EmittedFile, SearchAdapter, SearchDocument } from "@pagedeck/core";
import { defineSearch } from "./search.js";

const adapter = defineSearch() as Required<SearchAdapter>;

function page(
  locale: string,
  slug: string,
  body: string,
  domain?: string,
): SearchDocument {
  return {
    ...(domain === undefined ? {} : { domain }),
    locale,
    path: `/${slug}`,
    output: `/${locale}/${slug}`,
    title: `${slug} in ${locale}`,
    html: `<p>${body}</p><h2>About ${slug}</h2><p>shared words for ${locale}</p>`,
  };
}

const SITE: readonly SearchDocument[] = [
  page("en", "beta", "beta prose about otters"),
  page("en", "delta", "delta prose about kelp"),
  page("en", "gamma", "gamma prose about otters and kelp"),
  page("fr", "beta", "prose sur les loutres"),
  page("fr", "delta", "prose sur le varech"),
  page("fr", "gamma", "loutres et varech"),
  page("de", "beta", "Otter im Wasser", "de.example"),
  page("de", "delta", "Seetang im Wasser", "de.example"),
  page("de", "gamma", "Otter und Seetang", "de.example"),
];

function edited(
  locale: string,
  slug: string,
  html: string,
): SearchDocument[] {
  return SITE.map((one) =>
    one.locale === locale && one.path === `/${slug}` ? { ...one, html } : one,
  );
}

test("one page edited in one locale patches to the index a full build writes", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: edited("en", "delta", "<p>delta prose about seals, not kelp</p>"),
    }),
  ).toEqual([]);
});

test("a page added before every other page of its locale shifts every id, and still patches exactly", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: [...SITE, page("en", "alpha", "alpha prose about otters")],
    }),
  ).toEqual([]);
});

test("a page removed from the middle of its locale shifts the ids after it, and still patches exactly", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: SITE.filter((one) => !(one.locale === "fr" && one.path === "/beta")),
    }),
  ).toEqual([]);
});

test("a page added and another removed in one delta patches exactly", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: [
        ...SITE.filter((one) => !(one.locale === "en" && one.path === "/gamma")),
        page("en", "alpha", "alpha prose about kelp"),
      ],
    }),
  ).toEqual([]);
});

test("a locale whose every page is removed loses its whole directory", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: SITE.filter((one) => one.locale !== "fr"),
    }),
  ).toEqual([]);
});

test("a locale the previous index did not have gets a directory of its own", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: [...SITE, page("pt-BR", "beta", "prosa sobre lontras")],
    }),
  ).toEqual([]);
});

test("a locale moved to another tree leaves its old directory and fills a new one", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: SITE.map((one) =>
        one.locale === "fr" ? { ...one, domain: "fr.example" } : one,
      ),
    }),
  ).toEqual([]);
});

test("a page that loses its title patches to a document with no title key", async () => {
  expect(
    await searchPatchFaults(adapter, {
      before: SITE,
      after: SITE.map((one) => {
        if (!(one.locale === "de" && one.path === "/delta")) return one;
        const { title: _title, ...untitled } = one;
        return untitled;
      }),
    }),
  ).toEqual([]);
});

test("a locale that fills several shards patches exactly when an edit moves its boundaries", async () => {
  const identifiers = (from: number, count: number): string =>
    Array.from({ length: count }, (_, index) =>
      `ident${(from + index).toString(36)}`,
    ).join(" ");
  const before = Array.from({ length: 6 }, (_, index) =>
    page("en", `page${String(index)}`, identifiers(index * 700, 700)),
  );
  const full = await adapter.index(before);
  expect(
    full.filter((file) => file.path.includes("/terms-")).length,
  ).toBeGreaterThan(1);

  const after = [
    ...before.slice(1),
    page("en", "page0", identifiers(50_000, 200)),
  ];

  expect(await searchPatchFaults(adapter, { before, after })).toEqual([]);
});

test("the patch writes and prunes only inside the directory whose pages moved", async () => {
  const previous = (await adapter.index(SITE)).map(
    (file): EmittedFile => ({
      ...file,
      contents: new TextEncoder().encode(file.contents as string),
    }),
  );
  const after = edited("en", "delta", "<p>delta prose about seals</p>");

  const patch = await adapter.patch({
    previous,
    documents: after.filter((one) => one.locale === "en" && one.path === "/delta"),
    removed: [],
  });

  const touched = [
    ...patch.written.map((file) => file.path),
    ...patch.pruned.map((file) => file.path),
  ];
  expect(touched.length).toBeGreaterThan(0);
  for (const path of touched) expect(path).toMatch(/^\/search\/en\//);
  for (const file of patch.written) expect(file.domain).toBe(undefined);
});

test("every directory of the previous index that cannot be read back is refused in one report", async () => {
  const previous = (await adapter.index(SITE))
    .filter(
      (file) => !(file.domain === undefined && file.path === "/search/en/terms-0000.json"),
    )
    .map((file): EmittedFile =>
      file.path === "/search/fr/index.json" ||
      file.path === "/search/de/index.json"
        ? {
            ...file,
            contents: (file.contents as string).replace(
              '"format":1',
              '"format":0',
            ),
          }
        : file,
    );

  const thrown: unknown = await Promise.resolve(
    adapter.patch({
      previous,
      documents: [SITE[0] as SearchDocument],
      removed: [],
    }),
  ).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `Search index: the previous index cannot be patched, for 3 reasons — a patch reads each directory back out of its previous files, so every one has to be this format and whole; run pagedeck build to write the whole index again:
  "//de.example/search/de/index.json" is format 0, and this @pagedeck/search writes format 1
  "/search/en/index.json" names "terms-0000.json", and the previous index holds no such file
  "/search/fr/index.json" is format 0, and this @pagedeck/search writes format 1`,
  );
});
