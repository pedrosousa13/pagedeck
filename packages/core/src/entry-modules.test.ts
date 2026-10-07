import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";
import { planEntries } from "./entries.js";
import type { EntryPlan, PageDemand } from "./entries.js";
import { entryInputs, serveEntryModules } from "./entry-modules.js";
import type { Page } from "./pages.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-entry-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const FIXTURE: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-4b71"; }\n`,
  "Newsletter.js": `export default function Newsletter() { return "marker-newsletter-9ce3"; }\n`,
  "Quote.js": `export default function Quote() { return "marker-quote-2ad8"; }\n`,
};

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  for (const [file, source] of Object.entries(FIXTURE)) {
    writeFileSync(`${SRC}${file}`, source);
  }
  writeFileSync(ORIGIN, "export default {};\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function page(locale: string, path: `/${string}`, output: string): Page {
  return { locale, path, output, dependencies: [] };
}

const MODULES = {
  Hero: "./src/Hero.js",
  Newsletter: "./src/Newsletter.js",
  Quote: "./src/Quote.js",
};

const DEMANDS: readonly PageDemand[] = [
  {
    page: page("en", "/", "/en"),
    islands: [
      { component: "Hero", mode: "load" },
      { component: "Newsletter", mode: "visible" },
    ],
  },
  { page: page("en", "/pricing", "/en/pricing"), islands: [] },
];

const HOME = planEntries(DEMANDS, { modules: MODULES }).entries[0]?.name ?? "";

function chunksOf(
  result: Awaited<ReturnType<typeof build>>,
): { fileName: string; name: string; code: string }[] {
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((one) =>
    "output" in one
      ? one.output
          .filter((emitted) => emitted.type === "chunk")
          .map((chunk) => ({
            fileName: chunk.fileName,
            name: chunk.name,
            code: chunk.code,
          }))
      : [],
  );
}

async function clientBuild(
  plan: EntryPlan,
): Promise<ReturnType<typeof chunksOf>> {
  return chunksOf(
    await build({
      configFile: false,
      logLevel: "warn",
      root: FIXTURE_DIR,
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: entryInputs(plan),
          external: ["react", "react-dom", "react-dom/client"],
        },
      },
      plugins: [serveEntryModules(plan, ORIGIN)],
    }),
  );
}

test("a page's entry pulls exactly its own components", async () => {
  const plan = planEntries(DEMANDS, { modules: MODULES });
  const chunks = await clientBuild(plan);
  const shipped = chunks.map((chunk) => chunk.code).join("\n");

  expect(shipped).toContain("marker-hero-4b71");
  expect(shipped).toContain("marker-newsletter-9ce3");
  expect(shipped).not.toContain("marker-quote-2ad8");

  const entry = chunks.find((chunk) => chunk.name === HOME);
  expect(entry?.code).not.toContain("marker-hero-4b71");
  expect(entry?.code).not.toContain("marker-newsletter-9ce3");
  expect(
    chunks
      .filter((chunk) => chunk.code.includes("marker-hero-4b71"))
      .map((chunk) => chunk.name),
  ).toEqual(["Hero"]);
  expect(
    chunks
      .filter((chunk) => chunk.code.includes("marker-newsletter-9ce3"))
      .map((chunk) => chunk.name),
  ).toEqual(["Newsletter"]);
}, 60_000);

test("the content-only page gets no chunk of its own", async () => {
  const plan = planEntries(DEMANDS, { modules: MODULES });
  const chunks = await clientBuild(plan);

  expect(chunks.filter((chunk) => chunk.name === HOME)).toHaveLength(1);
  expect(chunks.filter((chunk) => chunk.name.startsWith("entry-"))).toHaveLength(
    1,
  );
}, 60_000);

test("two clean builds of one plan are byte-identical", async () => {
  const plan = planEntries(DEMANDS, { modules: MODULES });

  const once = await clientBuild(plan);
  const twice = await clientBuild(plan);

  expect(twice.map((chunk) => `${chunk.fileName}\n${chunk.code}`)).toEqual(
    once.map((chunk) => `${chunk.fileName}\n${chunk.code}`),
  );
}, 60_000);

test("the inputs name one id per entry and none per content-only page", () => {
  const plan = planEntries(DEMANDS, { modules: MODULES });

  expect(entryInputs(plan)).toEqual({ [HOME]: `\0fw:entry/${HOME}` });
});

test("a plan built from carried demands asks for the same inputs", () => {
  const rendered = planEntries(DEMANDS, { modules: MODULES });
  const carried = planEntries(
    DEMANDS.map((demand) => ({
      page: demand.page,
      carried:
        rendered.entries
          .find((entry) => entry.path === demand.page.path)
          ?.components.map(({ name, eager }) => ({ name, eager })) ?? [],
    })),
    { modules: MODULES },
  );

  expect(entryInputs(carried)).toEqual(entryInputs(rendered));
});

test("two pages keep two inputs, so neither loses its chunk", () => {
  const plan = planEntries(
    [
      ...DEMANDS,
      {
        page: page("de", "/pricing", "/de/pricing"),
        islands: [{ component: "Quote", mode: "idle" }],
      },
    ],
    { modules: MODULES },
  );
  const quote = plan.entries.find((entry) => entry.locale === "de")?.name ?? "";

  expect(quote).not.toBe(HOME);
  expect(entryInputs(plan)).toEqual({
    [HOME]: `\0fw:entry/${HOME}`,
    [quote]: `\0fw:entry/${quote}`,
  });
});

test("two pages with one entry text are one input, and one chunk", async () => {
  const plan = planEntries(
    [
      ...DEMANDS,
      {
        page: page("de", "/", "/de"),
        islands: [
          { component: "Newsletter", mode: "idle" },
          { component: "Hero", mode: "visible" },
        ],
      },
    ],
    { modules: MODULES },
  );

  expect(plan.entries.map((entry) => entry.name)).toEqual([HOME, HOME]);
  expect(entryInputs(plan)).toEqual({ [HOME]: `\0fw:entry/${HOME}` });

  const chunks = await clientBuild(plan);
  expect(chunks.filter((chunk) => chunk.name.startsWith("entry-"))).toHaveLength(
    1,
  );
  const shipped = chunks.map((chunk) => chunk.code).join("\n");
  expect(shipped).toContain("marker-hero-4b71");
  expect(shipped).toContain("marker-newsletter-9ce3");
}, 60_000);
