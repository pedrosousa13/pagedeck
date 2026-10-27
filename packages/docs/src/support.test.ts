import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_DEPENDENCIES } from "create-pagedeck";
import { expect, test } from "vitest";
import { PUBLIC_PACKAGES } from "../../core/src/public-packages.test-support.js";

const PACKAGES = join(import.meta.dirname, "..", "..");
const PAGE = join(import.meta.dirname, "..", "reference", "support.md");
const REPOSITORY = join(PACKAGES, "..");
const CI = join(REPOSITORY, ".github", "workflows", "ci.yml");

const NODE_POLICY_COPIES = [
  "README.md",
  "packages/core/README.md",
  "packages/create-pagedeck/README.md",
  "packages/docs/tutorials/your-first-site.md",
] as const;

const PACKAGE_NAME = /^(@pagedeck\/[a-z-]+|create-pagedeck)$/;

const REACT_PACKAGES = ["react", "react-dom"] as const;
const REACT_FIELDS = ["dependencies", "peerDependencies"] as const;

interface Manifest {
  name: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifests = (): Manifest[] =>
  PUBLIC_PACKAGES.map(
    (dir) => JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8")) as Manifest,
  );

const page = (): string => readFileSync(PAGE, "utf8");

function requiredSentence(text: string, pattern: RegExp, what: string): RegExpExecArray {
  const found = pattern.exec(text);
  if (found === null) {
    throw new Error(
      `reference/support.md: states no ${what} — keep the sentence this test reads, matching ${String(pattern)}`,
    );
  }
  return found;
}

const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((span) => span[1] as string);

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`reference/support.md: has no "${heading}" heading — keep it, this test reads under it`);
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

// Each bullet `- \`<range>\`: \`<package>\`, …`, its wrapped lines joined.
function declaredRanges(text: string): Map<string, string> {
  const bullets = section(text, "### What each package declares")
    .split(/\n(?=- )/)
    .filter((bullet) => bullet.startsWith("- "))
    .map((bullet) => bullet.replace(/\s*\n\s*/g, " "));
  const ranges = new Map<string, string>();
  for (const bullet of bullets) {
    const [range, ...spans] = codeSpans(bullet);
    for (const name of spans.filter((span) => PACKAGE_NAME.test(span))) ranges.set(name, range as string);
  }
  return ranges;
}

type Version = readonly [number, number, number];

function parseVersion(text: string): Version {
  const parts = text.split(".").map(Number);
  while (parts.length < 3) parts.push(0);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`"${text}" is not a version this test reads — write it as major.minor.patch`);
  }
  return parts as unknown as Version;
}

function compare(left: Version, right: Version): number {
  for (let at = 0; at < 3; at++) {
    const difference = (left[at] as number) - (right[at] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

// The two comparator forms the manifests write, `^x.y.z` and `>=x.y.z`, joined by `||`.
function admits(range: string, version: string): boolean {
  const wanted = parseVersion(version);
  return range.split("||").some((alternative) => {
    const found = /^\s*(\^|>=)(\d+\.\d+\.\d+)\s*$/.exec(alternative);
    if (found === null) {
      throw new Error(`"${range}" holds "${alternative.trim()}", which this test cannot read — write ^x.y.z or >=x.y.z`);
    }
    const floor = parseVersion(found[2] as string);
    if (compare(wanted, floor) < 0) return false;
    return found[1] === ">=" || wanted[0] === floor[0];
  });
}

function lowestOnLine(range: string, line: number): Version | undefined {
  const floors = range
    .split("||")
    .map((alternative) => parseVersion(alternative.trim().replace(/^(\^|>=)/, "")))
    .filter((floor) => floor[0] <= line)
    .map((floor): Version => (floor[0] === line ? floor : [line, 0, 0]));
  return floors.sort(compare)[0];
}

function supported(text: string): { floor: string; lines: number[] } {
  const found = requiredSentence(
    text,
    /\*\*Supported:\*\* Node\.js (\d+) from `(\d+\.\d+\.\d+)`, and Node\.js (\d+)\./,
    "supported Node.js lines",
  );
  return { floor: found[2] as string, lines: [Number(found[1]), Number(found[3])] };
}

function testedOnPage(text: string): string[] {
  return codeSpans(
    requiredSentence(text, /CI runs the install, scaffold and build checks on Node\.js (`[^`]+` and `[^`]+`)\./, "CI Node.js versions")[1] as string,
  );
}

function ciMatrix(): { node: string[]; versions: string[] } {
  const yaml = readFileSync(CI, "utf8");
  const matrices = [...yaml.matchAll(/^\s*node:\s*\[([^\]]*)\]\s*$/gm)];
  expect(matrices.length, "ci.yml should declare one `node: [...]` matrix").toBe(1);
  const node = ((matrices[0] as RegExpExecArray)[1] as string)
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""));
  const versions = [...yaml.matchAll(/^\s*node-version:\s*(.+?)\s*$/gm)].map((line) => line[1] as string);
  return { node, versions };
}

test("the page names every public package's engines.node exactly as its manifest declares it", () => {
  const declared = declaredRanges(page());
  const expected = new Map(manifests().map((manifest) => [manifest.name, manifest.engines?.node]));
  expect(
    Object.fromEntries([...declared].sort()),
    "reference/support.md's \"What each package declares\" is out of step with the manifests — list each public package under the engines.node its package.json declares",
  ).toEqual(Object.fromEntries([...expected].sort()));
});

test("every declared range admits the supported floor and Node.js 24, and the floor is the highest any package needs on its line", () => {
  const { floor, lines } = supported(page());
  const floorLine = parseVersion(floor)[0];
  const ranges = manifests().map((manifest) => ({ name: manifest.name, range: manifest.engines?.node ?? "" }));
  for (const { name, range } of ranges) {
    expect(admits(range, floor), `${name}'s engines.node "${range}" refuses the supported floor ${floor}`).toBe(true);
    for (const line of lines.filter((line) => line !== floorLine)) {
      expect(admits(range, `${String(line)}.0.0`), `${name}'s engines.node "${range}" refuses Node.js ${String(line)}`).toBe(true);
    }
  }
  const highest = ranges
    .map(({ range }) => lowestOnLine(range, floorLine))
    .filter((version): version is Version => version !== undefined)
    .sort(compare)
    .at(-1);
  expect(
    highest?.join("."),
    `the supported floor on reference/support.md is not the highest Node.js ${String(floorLine)} any public package needs — state that version as the floor`,
  ).toBe(floor);
});

test("ci.yml's Node matrix is the floor and each supported line, as the page states", () => {
  const text = page();
  const { floor, lines } = supported(text);
  const tested = testedOnPage(text);
  const { node, versions } = ciMatrix();
  expect(node, "ci.yml's `node` matrix differs from the Node.js versions reference/support.md says CI runs").toEqual(tested);
  expect(tested[0], "the first Node.js version CI runs should be the supported floor").toBe(floor);
  expect(
    tested.map((version) => parseVersion(version)[0]),
    "CI should run one Node.js version on each supported line",
  ).toEqual(lines);
  for (const version of versions) {
    expect(
      version === "${{ matrix.node }}" || tested.includes(version),
      `ci.yml sets node-version ${version}, which reference/support.md does not say CI runs`,
    ).toBe(true);
  }
});

const reactRange = (text: string): string =>
  requiredSentence(text, /declares `react` and `react-dom` as `([^`]+)`/, "React range")[1] as string;

test("every public react and react-dom range is the one the page states", () => {
  const range = reactRange(page());
  const found = manifests().flatMap((manifest) =>
    REACT_FIELDS.flatMap((field) =>
      REACT_PACKAGES.flatMap((name) => {
        const declared = manifest[field]?.[name];
        return declared === undefined ? [] : [{ where: `${manifest.name} ${field}.${name}`, declared }];
      }),
    ),
  );
  expect(found.length, "no public package depends on React, so nothing holds the page's React range").toBeGreaterThan(0);
  expect(
    found.filter(({ declared }) => declared !== range).map(({ where, declared }) => `${where}: ${declared}`),
    `reference/support.md says every public package declares ${range} — change the manifest or the page`,
  ).toEqual([]);
});

test("the range reader takes the manifests' forms and refuses any other", () => {
  expect(admits("^22.18.0 || >=23.7.0", "22.18.0")).toBe(true);
  expect(admits("^22.18.0 || >=23.7.0", "22.17.9")).toBe(false);
  expect(admits("^22.18.0 || >=23.7.0", "23.6.0")).toBe(false);
  expect(admits("^22.18.0 || >=23.7.0", "24.0.0")).toBe(true);
  expect(admits(">=22.0.0", "22.0.0")).toBe(true);
  expect(() => admits("~22.18.0", "22.18.0")).toThrow(/write \^x\.y\.z or >=x\.y\.z/);
  expect(lowestOnLine("^22.13.0 || >=23.4.0", 22)).toEqual([22, 13, 0]);
  expect(lowestOnLine(">=22.0.0", 22)).toEqual([22, 0, 0]);
  expect(lowestOnLine(">=23.0.0", 22)).toBeUndefined();
});

test("the React range npm create pagedeck writes into a new site is the one the page states", () => {
  const text = page();
  requiredSentence(text, /`npm create pagedeck` writes the same range into a new site/, "React range for a new site");
  const range = reactRange(text);
  expect(
    SITE_DEPENDENCIES,
    `reference/support.md says npm create pagedeck writes react and react-dom as ${range} — change SITE_DEPENDENCIES in packages/create-pagedeck/src/index.ts or the page`,
  ).toEqual({ react: range, "react-dom": range });
});

test("every short copy of the Node.js policy names the page's supported lines", () => {
  const text = page();
  const { floor, lines } = supported(text);
  const unsupported = requiredSentence(text, /\*\*Node\.js (\d+) is not supported\.\*\*/, "unsupported Node.js line")[1] as string;
  const sentence = `supports Node.js ${String(lines[0])} from ${floor.replace(/\.0$/, "")}, and Node.js ${String(lines[1])}. Node.js ${unsupported} is not supported.`;
  const drifted = NODE_POLICY_COPIES.filter(
    (file) => !readFileSync(join(REPOSITORY, file), "utf8").replace(/\s+/g, " ").includes(sentence),
  );
  expect(drifted, `each of these should say "${sentence}", as reference/support.md does — change the copy or the page`).toEqual([]);
});
