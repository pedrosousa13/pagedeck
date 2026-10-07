// A pure function of its parameters, so a rung can be re-measured byte for byte. Prose varies
// by locale over 1,024 words, because the store's size and gzip ratio are reported figures.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComponentNode, FixtureFile, FixturePage } from "@pagedeck/fixtures";
import { SYNTHETIC_LOCALES } from "./locales.js";

export interface SyntheticSiteOptions {
  /** Removed first, so a rerun leaves no previous rung's entries behind. */
  directory: string;
  /** Summed across every locale, as spec §16 counts. */
  pages: number;
  /** How many locales the site declares, from `SYNTHETIC_LOCALES` in order. */
  locales: number;
}

export interface SyntheticSite {
  directory: string;
  /** Exactly what is on disk: the harness checks the manifest's row count against it. */
  pages: number;
  locales: readonly string[];
  islandPages: number;
}

// A cycle, so every locale holds all three shapes at any scale of three pages or more.
const SHAPES = ["document", "cards", "interactive"] as const;

// A hash over the text's identity: a counter made gzip measure the generator, and a random
// source would break re-measurement.
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** The pieces words are built from: 24 x 9 x 12 = 2,592 possible syllables. */
const ONSETS = "b c d f g h k l m n p r s t v z br cl dr fl gr pl st tr".split(" ");
const NUCLEI = "a e i o u ai ea ou ie".split(" ");
const CODAS = " n r s t l m d ng ck st nt".split(" ");

function syllable(draw: number): string {
  const onset = ONSETS[draw % ONSETS.length] as string;
  const nucleus = NUCLEI[(draw >>> 5) % NUCLEI.length] as string;
  const coda = CODAS[(draw >>> 9) % CODAS.length] as string;
  return `${onset}${nucleus}${coda}`;
}

const VOCABULARY: readonly string[] = Array.from(
  { length: 1_024 },
  (_, index) =>
    `${syllable(hash(`vocabulary:${String(index)}:1`))}${syllable(hash(`vocabulary:${String(index)}:2`))}`,
);

// Seeded by locale too: a translation is not a copy, and copies would inflate compression.
function sentence(seed: string, count: number): string {
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // Squared, skewing the draw toward common words as real prose does.
    const draw = hash(`${seed}:${String(index)}`) % 65_536;
    const rank = Math.floor(((draw * draw) / (65_536 * 65_536)) * VOCABULARY.length);
    words.push(VOCABULARY[rank] as string);
  }
  return `${words.join(" ")}.`;
}

function pathOf(index: number): string {
  const shape = SHAPES[index % SHAPES.length];
  if (shape === "document") return `guides/guide-${String(index)}`;
  if (shape === "cards") return `blog/post-${String(index)}`;
  return `features/feature-${String(index)}`;
}

function treeOf(locale: string, index: number, islanded: boolean): ComponentNode[] {
  const seed = `${locale}:${String(index)}`;
  const cards = (from: number, count: number): ComponentNode[] =>
    Array.from({ length: count }, (_, offset) => ({
      component: "card",
      props: {
        title: `Card ${String(from + offset)}`,
        body: sentence(`${seed}:card:${String(from + offset)}`, 12),
      },
    }));

  return [
    {
      component: "section",
      props: {
        heading: `Section ${String(index)}`,
        // Three tones, so the class manifest is a set rather than a constant.
        tone: ["calm", "bold", "plain"][index % 3] as string,
      },
      children: [
        ...cards(0, 3),
        ...(islanded
          ? [{ component: "counter", props: { label: `Votes ${String(index)}` } }]
          : []),
      ],
    },
    {
      component: "section",
      props: { heading: `More ${String(index)}`, tone: "plain" },
      children: cards(3, 2),
    },
  ];
}

function pageOf(locale: string, index: number): FixturePage {
  const shape = SHAPES[index % SHAPES.length];
  const seed = `${locale}:${String(index)}`;
  if (shape === "document") {
    return {
      mode: "template",
      title: `Guide ${String(index)}`,
      template: "doc_page",
      fields: {
        lead: sentence(`${seed}:lead`, 18),
        body: Array.from({ length: 6 }, (_, paragraph) =>
          sentence(`${seed}:body:${String(paragraph)}`, 34),
        ),
      },
    };
  }
  return {
    mode: "tree",
    title: shape === "cards" ? `Post ${String(index)}` : `Feature ${String(index)}`,
    tree: treeOf(locale, index, shape === "interactive"),
  };
}

// A bare self-reference, not a relative `.js`: Node loads this with types stripped (#182).
const CONFIG = `import { syntheticSiteConfig } from "@pagedeck/bench";

export default syntheticSiteConfig(import.meta.dirname);
`;

/**
 * Every locale files the same paths, the last trimmed so the total is `pages` exactly.
 * Every fixture is `rev: 1`, so a rewrite at `rev: 2` is a one-entry delta.
 */
export function generateSyntheticSite(
  options: SyntheticSiteOptions,
): SyntheticSite {
  const { directory, pages, locales } = options;
  if (locales < 1 || locales > SYNTHETIC_LOCALES.length) {
    throw new Error(
      `Synthetic site "${directory}": asks for ${String(locales)} locales, and packages/bench/src/locales.ts names ${String(SYNTHETIC_LOCALES.length)} — ask for between 1 and ${String(SYNTHETIC_LOCALES.length)}, or add rows there with the code and label defineLocales needs`,
    );
  }
  if (pages < 1 || !Number.isInteger(pages)) {
    throw new Error(
      `Synthetic site "${directory}": asks for ${String(pages)} pages — ask for a positive whole number, which is what a rung of the ladder is`,
    );
  }

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "pagedeck.config.ts"), CONFIG);

  const codes = SYNTHETIC_LOCALES.slice(0, locales).map((one) => one.code);
  const perLocale = Math.ceil(pages / locales);
  const content = join(directory, "content");

  let written = 0;
  let islandPages = 0;
  for (const code of codes) {
    for (let index = 0; index < perLocale && written < pages; index += 1) {
      const file = join(content, code, `${pathOf(index)}.json`);
      mkdirSync(dirname(file), { recursive: true });
      const payload: FixtureFile<FixturePage> = { rev: 1, data: pageOf(code, index) };
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
      written += 1;
      if (SHAPES[index % SHAPES.length] === "interactive") islandPages += 1;
    }
  }

  return { directory, pages: written, locales: codes, islandPages };
}
