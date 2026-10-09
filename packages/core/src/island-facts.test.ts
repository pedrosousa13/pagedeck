import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import { scanIslandFacts } from "./island-facts.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-island-facts-test/", import.meta.url),
);
const SRC = `${FIXTURE_DIR}src/`;
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const FIXTURE: Record<string, string> = {
  "Hero.js": `"use client";\nexport default function Hero() { return "hero"; }\n`,
  "Copy.js": `export default function Copy() { return "copy"; }\n`,
  "Late.js": `"use client";\nimport { useEffect } from "react";\nimport { preinit } from "react-dom";\nexport default function Late() {\n  useEffect(() => { preinit("/late.css", { as: "style" }); }, []);\n  return "late";\n}\n`,
  "Eager.js": `import { preinit } from "react-dom";\nexport default function Eager() { preinit("/eager.css", { as: "style" }); return "eager"; }\n`,
  "Styled.js": `import "./styled.css";\nexport default function Styled() { return "styled"; }\n`,
  "Twice.js": `import "./styled.css";\nimport "./other.css?inline";\nexport default function Twice() { return "twice"; }\n`,
  "Lit.js": `"use client";\nimport "./styled.css";\nexport default function Lit() { return "lit"; }\n`,
  "styled.css": `.styled { color: red; }\n`,
  "other.css": `.other { color: blue; }\n`,
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

test("the scan reports the registry name each client module is registered under", async () => {
  const { facts, clientComponents } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Hero: "./src/Hero.js", Copy: "./src/Copy.js" },
  });

  expect(facts).toEqual({
    Hero: { useClient: true },
    Copy: { useClient: false },
  });
  expect(clientComponents).toEqual({ [`${SRC}Hero.js`]: "Hero" });
}, 120_000);

test("two registry names may share one static module", async () => {
  const { facts, clientComponents } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Copy: "./src/Copy.js", Legal: "./src/Copy.js" },
  });

  expect(facts).toEqual({
    Copy: { useClient: false },
    Legal: { useClient: false },
  });
  expect(clientComponents).toEqual({});
}, 120_000);

test('the scan refuses a "use client" module registered under two names', async () => {
  const scan = async (): Promise<unknown> =>
    await scanIslandFacts({
      root: FIXTURE_DIR,
      origin: ORIGIN,
      modules: { Banner: "./src/../src/Hero.js", Hero: "./src/Hero.js" },
    });

  await expect(scan()).rejects.toThrow(ConfigError);
  await expect(scan()).rejects.toThrow(
    [
      'Island scan: 1 module carrying "use client" is registered under more than one component name, so a rendered instance of it cannot be told which name it is — register it under one name, or give each name a module of its own:',
      `  "${SRC}Hero.js" — "Banner", "Hero"`,
    ].join("\n"),
  );
}, 240_000);

test('the scan warns about preinit imported inside a "use client" closure', async () => {
  const { warnings } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Late: "./src/Late.js", Eager: "./src/Eager.js" },
  });

  expect(warnings).toEqual([
    'Island scan: 1 module in a "use client" closure imports preinit or preinitModule from react-dom — a preinit call places a stylesheet past the <head> tiers the build owns, which the build refuses when the rendered HTML shows it; this is a warning and not a refusal because a call made from an effect leaves nothing in the HTML to see, and an import reached through a re-export or an alias leaves nothing here to see either:\n' +
      `  "${SRC}Late.js" — preinit`,
  ]);
}, 240_000);

test("the scan names each component whose module does not resolve", async () => {
  const scan = async (): Promise<unknown> =>
    await scanIslandFacts({
      root: FIXTURE_DIR,
      origin: ORIGIN,
      modules: {
        Hero: "./src/Hero.js",
        Ghost: "./src/Ghost.js",
        Phantom: "@pagedeck/phantom/widget",
      },
    });

  const error = await scan().catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    [
      "Island scan: 2 component modules did not resolve, so their directives could not be read — install the package, or fix the component's path or specifier in build.components:",
      `  "Ghost" — "./src/Ghost.js", resolved against "${ORIGIN}"`,
      `  "Phantom" — "@pagedeck/phantom/widget", resolved against "${ORIGIN}"`,
    ].join("\n"),
  );
}, 120_000);

const UNLINKED_FIX =
  ' — import the stylesheet from a "use client" module, or list it in build.css; this is a warning and not a refusal because every page still renders, and a page may link a stylesheet some other way the scan cannot see, such as a head link to a passthrough file:';

test("the scan warns about a stylesheet only a static component imports", async () => {
  const { warnings } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Styled: "./src/Styled.js" },
  });

  expect(warnings).toEqual([
    `Island scan: 1 stylesheet is imported only by modules outside every "use client" closure, so no page links it${UNLINKED_FIX}\n` +
      `  "${SRC}styled.css" — imported by "${SRC}Styled.js"`,
  ]);
}, 120_000);

test("a stylesheet an island module also imports is not reported", async () => {
  const { warnings } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Styled: "./src/Styled.js", Lit: "./src/Lit.js" },
  });

  expect(warnings).toEqual([]);
}, 120_000);

test("a stylesheet build.css lists is not reported", async () => {
  const { warnings } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Styled: "./src/Styled.js" },
    css: [`${SRC}styled.css`],
  });

  expect(warnings).toEqual([]);
}, 120_000);

test("two unlinked stylesheets are one warning naming both, each id without its query", async () => {
  const { warnings } = await scanIslandFacts({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    modules: { Styled: "./src/Styled.js", Twice: "./src/Twice.js" },
  });

  expect(warnings).toEqual([
    `Island scan: 2 stylesheets are imported only by modules outside every "use client" closure, so no page links them${UNLINKED_FIX}\n` +
      `  "${SRC}other.css" — imported by "${SRC}Twice.js"\n` +
      `  "${SRC}styled.css" — imported by "${SRC}Styled.js", "${SRC}Twice.js"`,
  ]);
}, 120_000);
