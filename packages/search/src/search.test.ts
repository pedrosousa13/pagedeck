import { expect, test } from "vitest";
import type { SearchDocument } from "@pagedeck/core";
import { defineSearch } from "./search.js";

test("the adapter names itself, so a build can say which one ran", () => {
  expect(defineSearch().name).toBe("@pagedeck/search");
});

test("the adapter answers with the index files", async () => {
  const files = await defineSearch().index([
    {
      locale: "en",
      path: "/guide",
      output: "/en/guide",
      html: "<p>widget</p>",
    },
  ]);
  expect(files.map((file) => file.path)).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0000.json",
  ]);
});

const site = (): SearchDocument[] => {
  const documents: SearchDocument[] = [];
  for (const domain of [undefined, "shop"]) {
    for (const locale of ["en", "de", "pt-BR"]) {
      for (const slug of ["alpha", "beta", "gamma", "delta"]) {
        documents.push({
          ...(domain === undefined ? {} : { domain }),
          locale,
          path: `/${slug}`,
          output: `/${locale}/${slug}`,
          title: `${slug} in ${locale}`,
          html:
            `<p>shared ${slug} prose</p>` +
            `<h2>Section ${slug}</h2>` +
            `<p>shared body about ${locale} and ${slug}</p>`,
        });
      }
    }
  }
  return documents;
};

// A fixed permutation, so a failure does not land on one run in twenty.
const shuffle = <T,>(items: readonly T[]): T[] => {
  const reversed = [...items].reverse();
  const half = Math.ceil(reversed.length / 2);
  const shuffled: T[] = [];
  for (let index = 0; index < half; index += 1) {
    shuffled.push(reversed[index] as T);
    const mirror = reversed[index + half];
    if (mirror !== undefined) shuffled.push(mirror);
  }
  return shuffled;
};

test("the same documents in a different order produce byte-identical files", async () => {
  const documents = site();
  const shuffled = shuffle(documents);
  expect(shuffled).not.toEqual(documents);

  const [one, two] = await Promise.all([
    defineSearch().index(documents),
    defineSearch().index(shuffled),
  ]);
  // Compared as bytes: spec §11 is over the files, and JSON key order can differ.
  expect(
    two.map((file) => [file.domain, file.path, file.contents]),
  ).toEqual(one.map((file) => [file.domain, file.path, file.contents]));
});

test("a locale is refused before any file is written", async () => {
  await expect(
    defineSearch().index([
      {
        locale: "en/us",
        path: "/guide",
        output: "/en/guide",
        html: "<p>widget</p>",
      },
    ]),
  ).rejects.toThrow("Search index: 1 locale is not a path segment");
});
