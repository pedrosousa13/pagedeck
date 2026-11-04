import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const MINIMUM_CHECKOUTS = 8;

interface Checkout {
  readonly file: string;
  readonly line: number;
  readonly persistsCredentials: boolean;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .sort()
    .map((entry) => join(WORKFLOWS, entry))
    .filter((path) => statSync(path).isFile());
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

const USES =
  /(?:^\s*(?:-\s+)?|[{,]\s*)(?:uses|"uses"|'uses')\s*:\s*(["']?)([^\s"',}]*)\1/;

const WITH = /^(?:with|"with"|'with')\s*:\s*(.*)$/;

const PERSIST_FALSE =
  /^(?:persist-credentials|"persist-credentials"|'persist-credentials')\s*:\s*(["']?)false\1\s*(?:#.*)?$/;

const FLOW_WITH = /[{,]\s*(?:with|"with"|'with')\s*:\s*\{([^}]*)\}/;

function isCheckout(text: string): boolean {
  return (USES.exec(text)?.[2] ?? "").startsWith("actions/checkout@");
}

function flowSetsFalse(inner: string): boolean {
  return inner.split(",").some((entry) => PERSIST_FALSE.test(entry.trim()));
}

function checkouts(source: string, file: string): Checkout[] {
  const lines = source.split("\n");
  const found: Checkout[] = [];

  lines.forEach((first, start) => {
    const item = /^(\s*)-\s+/.exec(first);
    if (item === null) return;
    const dash = (item[1] ?? "").length;
    const keyColumn = item[0].length;

    let end = start + 1;
    while (end < lines.length) {
      const body = lines[end] ?? "";
      if (body.trim() !== "" && indentOf(body) <= dash) break;
      end += 1;
    }
    const step = lines.slice(start, end);
    const head = first.slice(keyColumn);

    if (head.startsWith("{")) {
      const text = [head, ...step.slice(1).map((line) => line.trim())].join(
        " ",
      );
      if (!isCheckout(text)) return;
      const inner = FLOW_WITH.exec(text)?.[1];
      found.push({
        file,
        line: start + 1,
        persistsCredentials: inner === undefined || !flowSetsFalse(inner),
      });
      return;
    }

    const keys = step.flatMap((line, offset) =>
      offset === 0
        ? [{ offset, text: head }]
        : indentOf(line) === keyColumn
          ? [{ offset, text: line.trim() }]
          : [],
    );
    if (!keys.some(({ text }) => isCheckout(text))) return;

    let setsFalse = false;
    for (const { offset, text } of keys) {
      const withKey = WITH.exec(text);
      if (withKey === null) continue;
      const rest = (withKey[1] ?? "").trim();
      if (rest.startsWith("{")) {
        setsFalse ||= flowSetsFalse(rest.replace(/^\{|\}\s*(?:#.*)?$/g, ""));
        continue;
      }
      const body = [];
      for (const line of step.slice(offset + 1)) {
        if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
        if (indentOf(line) <= keyColumn) break;
        body.push(line);
      }
      const childColumn = indentOf(body[0] ?? "");
      setsFalse ||= body.some(
        (line) =>
          indentOf(line) === childColumn && PERSIST_FALSE.test(line.trim()),
      );
    }
    found.push({ file, line: start + 1, persistsCredentials: !setsFalse });
  });

  return found;
}

test("every actions/checkout step sets persist-credentials: false", () => {
  const found = workflowFiles().flatMap((path) =>
    checkouts(
      readFileSync(path, "utf8"),
      relative(REPO, path).split(sep).join("/"),
    ),
  );
  expect(found.length, checkoutsReport(found.length)).toBeGreaterThanOrEqual(
    MINIMUM_CHECKOUTS,
  );

  const persisting = found.filter((step) => step.persistsCredentials);
  expect(persisting, persistingReport(persisting)).toEqual([]);
});

function checkoutsReport(count: number): string {
  return `Workflow checkouts: the scan of "${WORKFLOWS}" read ${String(count)} actions/checkout step${count === 1 ? "" : "s"} of at least ${String(MINIMUM_CHECKOUTS)}, so the rule below passed over too little to mean anything — checkouts() has stopped recognising the shape the workflows write a step in, and that is what to fix; lower MINIMUM_CHECKOUTS only if checkout steps were deliberately removed`;
}

function persistingReport(persisting: readonly Checkout[]): string {
  if (persisting.length === 0) return "";
  const list = persisting
    .map(({ file, line }) => `  ${file}:${String(line)}`)
    .join("\n");
  return `Workflow checkouts: ${String(persisting.length)} actions/checkout step${persisting.length === 1 ? " leaves" : "s leave"} the job's token in .git/config, where every later step, PR code included, can read it — add persist-credentials: false under the step's with:; a later step that must authenticate to git gets the credentials passed to it explicitly (#294):\n${list}`;
}

function faultsIn(source: string): string[] {
  return checkouts(source, "fixture.yml")
    .filter((step) => step.persistsCredentials)
    .map(({ line }) => String(line));
}

const SHA = "11d5960a326750d5838078e36cf38b85af677262";

test("checkouts() counts a checkout written with quoted keys and values, or as a flow mapping", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: "actions/checkout@${SHA}" # v4.4.0`,
    "      - name: Quoted key",
    `        'uses': actions/checkout@${SHA} # v4.4.0`,
    `      - { name: Flow, uses: actions/checkout@${SHA} }`,
    `      - { "uses": 'actions/checkout@${SHA}', with: { persist-credentials: false } }`,
    "      - name: Not a checkout",
    `        uses: actions/setup-node@${SHA} # v4.4.0`,
  ].join("\n");
  expect(checkouts(source, "fixture.yml")).toHaveLength(4);
  expect(faultsIn(source)).toEqual(["4", "5", "7"]);
});

test("checkouts() counts persist-credentials only directly under the step's with:, and only as false", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    "        env:",
    "          persist-credentials: false",
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    "        run: |",
    "          persist-credentials: false",
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    "        with:",
    "          persist-credentials: ${{ inputs.persist }}",
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    "        with:",
    "          nested:",
    "            persist-credentials: false",
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    "        with:",
    "          fetch-depth: 0",
    '          persist-credentials: "false"',
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    "        with: { persist-credentials: 'false' }",
    "      - with:",
    "          persist-credentials: false # never stored",
    `        uses: actions/checkout@${SHA} # v4.4.0`,
  ].join("\n");
  expect(checkouts(source, "fixture.yml")).toHaveLength(7);
  expect(faultsIn(source)).toEqual(["4", "7", "10", "13"]);
});
