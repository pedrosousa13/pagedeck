import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");

const CATALOGUE = join("docs", "error-messages.md");

const SELF = relative(REPO, import.meta.filename).split(sep).join("/");

// Measured on #444 and #482: below these floors a literal matches vacuously.
const MIN_FIXED = 24;
const MIN_RUN = 12;

const MINIMUM_MESSAGES = 150;
const MINIMUM_LITERALS = 800;

interface Message {
  readonly line: number;
  readonly text: string;
}

function cataloguedMessages(markdown: string): Message[] {
  const messages: Message[] = [];
  let open: { line: number; lines: string[] } | undefined;
  let inFence = false;
  let fenced = false;
  const close = (): void => {
    if (open === undefined) return;
    while (open.lines.length > 0 && (open.lines.at(-1) ?? "").trim() === "") {
      open.lines.pop();
    }
    messages.push({ line: open.line, text: open.lines.join("\n") });
    open = undefined;
  };
  markdown.split("\n").forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      close();
      inFence = !inFence;
      fenced = inFence && line.trim() === "```";
      return;
    }
    if (!inFence || !fenced) return;
    if (line.trim() === "") {
      open?.lines.push(line);
      return;
    }
    if (/^\s/.test(line)) {
      if (open === undefined) open = { line: index + 1, lines: [line] };
      else open.lines.push(line);
      return;
    }
    close();
    open = { line: index + 1, lines: [line] };
  });
  close();
  return messages;
}

interface Template {
  readonly from: string;
  readonly spans: readonly string[];
}

function templatesIn(from: string, source: string): Template[] {
  const found: Template[] = [];
  let at = 0;

  const escaped = (): string => {
    const after = source[at + 1] ?? "";
    const simple: Record<string, string> = {
      "\n": "",
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    if (after === "u" && source[at + 2] === "{") {
      const end = source.indexOf("}", at);
      const text = String.fromCodePoint(
        Number.parseInt(source.slice(at + 3, end), 16),
      );
      at = end + 1;
      return text;
    }
    if (after === "u") {
      const text = String.fromCharCode(
        Number.parseInt(source.slice(at + 2, at + 6), 16),
      );
      at += 6;
      return text;
    }
    if (after === "x") {
      const text = String.fromCharCode(
        Number.parseInt(source.slice(at + 2, at + 4), 16),
      );
      at += 4;
      return text;
    }
    at += 2;
    return simple[after] ?? after;
  };

  const readQuoted = (quote: string): string => {
    at++;
    let text = "";
    while (at < source.length) {
      const here = source[at];
      if (here === "\\") {
        text += escaped();
        continue;
      }
      if (here === quote || here === "\n") {
        at++;
        return text;
      }
      text += here;
      at++;
    }
    return text;
  };

  const readTemplate = (): readonly string[] => {
    at++;
    const spans = [""];
    const add = (text: string): void => {
      spans[spans.length - 1] = (spans.at(-1) ?? "") + text;
    };
    while (at < source.length) {
      const here = source[at];
      if (here === "\\") {
        add(escaped());
        continue;
      }
      if (here === "`") {
        at++;
        return spans;
      }
      if (here === "$" && source[at + 1] === "{") {
        at += 2;
        let depth = 1;
        while (at < source.length && depth > 0) {
          const inside = source[at];
          if (inside === "{") depth++;
          else if (inside === "}") depth--;
          else if (inside === "`") {
            found.push({ from, spans: readTemplate() });
            continue;
          } else if (inside === '"' || inside === "'") {
            readQuoted(inside);
            continue;
          }
          at++;
        }
        spans.push("");
        continue;
      }
      add(here ?? "");
      at++;
    }
    return spans;
  };

  while (at < source.length) {
    const here = source[at];
    const next = source[at + 1];
    if (here === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
      continue;
    }
    if (here === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      at = end === -1 ? source.length : end + 2;
      continue;
    }
    if (here === "`") {
      found.push({ from, spans: readTemplate() });
      continue;
    }
    if (here === '"' || here === "'") {
      found.push({ from, spans: [readQuoted(here)] });
      continue;
    }
    at++;
  }
  return found;
}

function worthMatching({ spans }: Template): boolean {
  const fixed = spans.join("").length;
  const run = Math.max(0, ...spans.map((span) => span.length));
  return fixed >= MIN_FIXED && run >= MIN_RUN;
}

function produces({ spans }: Template): RegExp {
  const quoted = spans.map((span) =>
    span.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^${quoted.join("[\\s\\S]*")}$`);
}

function walk(dir: string, wanted: (entry: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path, wanted));
      continue;
    }
    if (wanted(entry)) found.push(path);
  }
  return found;
}

function shippingModules(): string[] {
  const found: string[] = [];
  for (const dir of readdirSync(join(REPO, "packages")).sort()) {
    const src = join(REPO, "packages", dir, "src");
    if (!existsSync(src)) continue;
    found.push(
      ...walk(
        src,
        (entry) =>
          /\.tsx?$/.test(entry) &&
          !/\.(?:test|harness|test-support)\.tsx?$/.test(entry),
      ),
    );
  }
  return found;
}

type Reason = "assembled" | "excerpt" | "foreign";

interface Unchecked {
  readonly names: string;
  readonly because: Reason;
}

const UNCHECKED: readonly Unchecked[] = [
  { names: 'Fixture "/site/content/en/home.json":', because: "assembled" },
  { names: 'Component "Sheeted": declares a stylesheet', because: "assembled" },
  { names: "Entry /en/home: declares a stylesheet", because: "assembled" },
  { names: "Island scan: 2 component modules will", because: "assembled" },
  { names: 'Collection "posts": 2 entries have', because: "assembled" },
  { names: 'Edge target "nginx": 2 values cannot', because: "assembled" },
  {
    names: 'Edge target "cloudflare-worker": 1 header name',
    because: "assembled",
  },
  {
    names: 'Edge target "cloudflare-worker": 1 header value',
    because: "assembled",
  },
  { names: 'Edge target "netlify": 1 redirect source', because: "assembled" },
  { names: 'Edge target "netlify": 2 values cannot', because: "assembled" },
  { names: 'Edge target "netlify": 1 header name', because: "assembled" },
  {
    names: '"build.budget" declares 1 limit',
    because: "assembled",
  },
  { names: '"build.budget" declares 1 key', because: "assembled" },
  { names: '"build.budget" holds', because: "assembled" },
  { names: '"build.criticalCss" declares', because: "assembled" },
  { names: '"build.criticalCss" holds', because: "assembled" },
  { names: '"build.scripts.pageTypes"', because: "assembled" },
  { names: '"build.retention" must', because: "assembled" },
  { names: '"build.routing" declares 4', because: "assembled" },
  { names: 'redirects[0] — "from" — "  " — the', because: "assembled" },
  { names: 'experiments[0] — "variants" — undefined', because: "assembled" },
  { names: '"build.routing" declares 1 field', because: "assembled" },
  { names: '"build.routing" declares 1 member', because: "assembled" },
  { names: '"build.routing" declares 1 entry', because: "assembled" },
  { names: '"build.routing" must', because: "assembled" },
  { names: "Routing manifest: 1 redirect target", because: "assembled" },
  { names: "Routing manifest: 1 path is redirected", because: "assembled" },
  { names: "Routing manifest: 1 header value", because: "assembled" },
  { names: "Routing manifest: 1 experiment declares no", because: "assembled" },
  { names: "Routing manifest: 1 variant weight", because: "assembled" },
  { names: "Routing manifest: 2 experiments declare", because: "assembled" },
  { names: "Routing manifest: 2 experiments name", because: "assembled" },
  { names: "Image settings: declares 1 width that", because: "assembled" },
  { names: "Critical CSS: 1 inlined stylesheet", because: "assembled" },
  { names: "Critical CSS: 1 stylesheet cannot be", because: "assembled" },
  { names: "Client build: 2 grouped specifiers", because: "assembled" },
  { names: "Client build: 1 component specifier", because: "assembled" },
  { names: "Locale set: 1 locale declares a domain", because: "assembled" },
  { names: "Locale set: 2 locales declare domains", because: "assembled" },
  { names: "Locale set: 1 locale falls back to", because: "assembled" },
  { names: "the route holds a query", because: "assembled" },
  { names: "the route holds a malformed", because: "assembled" },
  { names: "the route holds a lone", because: "assembled" },
  { names: "the route holds a segment", because: "assembled" },
  { names: "Security headers: this site declares", because: "assembled" },
  { names: "Class drift: 1 supplement cannot be", because: "assembled" },
  { names: "Root providers: the stack this page", because: "assembled" },
  { names: "the default export — a function, not", because: "assembled" },
  { names: "outermost first:\n  stack[0]", because: "assembled" },
  { names: "Shared store: 2 providers deliver a", because: "assembled" },
  { names: "Shared store: 2 atoms are hydrated", because: "assembled" },
  { names: "holds no PUT URL for 2 keys this apply writes", because: "assembled" },
  { names: "holds no DELETE URL for 1 key this prune deletes", because: "assembled" },
  { names: "the prune would delete 1 key the deploy writes for itself", because: "assembled" },
  { names: 'en /pricing — "bg-lime-300" — no source', because: "excerpt" },
  { names: "[BABEL] Note: The code generator has", because: "foreign" },
];

const document = readFileSync(join(REPO, CATALOGUE), "utf8");
const messages = cataloguedMessages(document);

function shippingTemplates(): Template[] {
  return shippingModules().flatMap((file) =>
    templatesIn(
      relative(REPO, file).split(sep).join("/"),
      readFileSync(file, "utf8"),
    ),
  );
}

test("every catalogued message is one this code still produces", () => {
  const pool = shippingTemplates().filter(worthMatching).map(produces);

  expect(
    messages.length,
    `Catalogued messages: the walk found fewer than ${String(MINIMUM_MESSAGES)} fenced messages in ${CATALOGUE} — the Markdown reader has stopped seeing fences, so fix it before reading a green run below as evidence about the catalogue`,
  ).toBeGreaterThanOrEqual(MINIMUM_MESSAGES);
  expect(
    pool.length,
    `Catalogued messages: the walk found fewer than ${String(MINIMUM_LITERALS)} literals worth matching in shipping source — either the module walk has stopped reaching files or the literal scanner has broken; fix the reader rather than lowering the floor`,
  ).toBeGreaterThanOrEqual(MINIMUM_LITERALS);

  const unexplained = messages.filter(
    (message) =>
      !pool.some((template) => template.test(message.text)) &&
      !UNCHECKED.some(({ names }) => message.text.includes(names)),
  );

  expect(unexplained, driftReport(unexplained)).toEqual([]);
});

function driftReport(unexplained: readonly Message[]): string {
  const count = unexplained.length;
  const lines = unexplained.map(
    ({ line, text }) =>
      `${CATALOGUE.split(sep).join("/")}:${String(line)}: ${text.split("\n")[0] ?? ""}`,
  );
  return `Catalogued messages: ${String(count)} message${count === 1 ? " is" : "s are"} quoted in ${CATALOGUE} that no shipping literal produces — correct each quote to what its producer emits; only a message the producer assembles from more than one literal belongs in UNCHECKED in ${SELF}, and listing a drifted one there hides the drift rather than fixing it:\n  ${lines.join("\n  ")}`;
}

test("every unchecked listing names one message this code does not produce", () => {
  const pool = shippingTemplates().filter(worthMatching).map(produces);
  const faults: string[] = [];

  for (const { names, because } of UNCHECKED) {
    const held = messages.filter((message) => message.text.includes(names));
    if (held.length !== 1) {
      faults.push(
        `\`${names.replace(/\n/g, "\\n")}\` (${because}) — ${held.length === 0 ? "no catalogued message holds it" : `${String(held.length)} catalogued messages hold it`}`,
      );
      continue;
    }
    const [message] = held;
    if (message !== undefined && pool.some((t) => t.test(message.text))) {
      faults.push(
        `\`${names.replace(/\n/g, "\\n")}\` (${because}) — ${CATALOGUE.split(sep).join("/")}:${String(message.line)} is produced by a shipping literal now`,
      );
    }
  }

  expect(
    faults,
    `Catalogued messages: ${String(faults.length)} listing${faults.length === 1 ? "" : "s"} in UNCHECKED in ${SELF} no longer name${faults.length === 1 ? "s" : ""} one message this code cannot produce — rewrite the substring so it holds in exactly one message, or delete the listing, which is what a message that became matchable earns:\n  ${faults.join("\n  ")}`,
  ).toEqual([]);
});

const PREAMBLE_SPLIT =
  /of\s+the\s+(\d+)\s+messages\s+fenced\s+below,\s+(\d+)\s+are\s+checked[\s\S]{0,80}?and\s+(\d+)\s+are\s+not/i;
const PREAMBLE_REASONS =
  /(\d+)\s+because\s+the\s+producer\s+assembles[\s\S]{0,80}?(\d+)\s+because\s+the\s+fence\s+quotes[\s\S]{0,80}?(\d+)\s+because\s+Babel/i;
const PREAMBLE_PINNED = /pin\s+(\d+)\s+of\s+the\s+(\d+)\s+fenced\s+characters/i;

function listed(because: Reason): string {
  return String(UNCHECKED.filter((entry) => entry.because === because).length);
}

function measure(): { checked: number; pinned: number; characters: number } {
  const pool = shippingTemplates()
    .filter(worthMatching)
    .map((template) => ({
      fixed: template.spans.join("").length,
      matches: produces(template),
    }));
  const checked = messages.filter((message) =>
    pool.some(({ matches }) => matches.test(message.text)),
  );
  const pinned = checked.reduce(
    (total, message) =>
      total +
      Math.max(
        ...pool
          .filter(({ matches }) => matches.test(message.text))
          .map(({ fixed }) => fixed),
      ),
    0,
  );
  const characters = messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
  return {
    checked: checked.length,
    pinned,
    characters,
  };
}

test("the catalogue's preamble states the totals this run measures", () => {
  const statedSplit = PREAMBLE_SPLIT.exec(document);
  expect(
    statedSplit,
    `Catalogued messages: ${CATALOGUE}'s preamble no longer states its split in the form "of the N messages fenced below, M are checked … and K are not" — restore that sentence, or move this assertion to wherever the split went`,
  ).not.toBeNull();

  const statedReasons = PREAMBLE_REASONS.exec(document);
  expect(
    statedReasons,
    `Catalogued messages: ${CATALOGUE}'s preamble no longer breaks the unchecked count into its reasons in the form "N because the producer assembles … N because the fence quotes … N because Babel" — restore that sentence, or move this assertion to wherever the breakdown went`,
  ).not.toBeNull();

  const statedPinned = PREAMBLE_PINNED.exec(document);
  expect(
    statedPinned,
    `Catalogued messages: ${CATALOGUE}'s preamble no longer states how much of the catalogue it pins, in the form "pin N of the M fenced characters" — restore that sentence, or move this assertion to wherever the figure went`,
  ).not.toBeNull();

  const { checked, pinned, characters: fenced } = measure();

  expect(
    [statedSplit?.[1], statedSplit?.[2], statedSplit?.[3]],
    `Catalogued messages: ${CATALOGUE}'s preamble says it fences ${String(statedSplit?.[1])} messages of which ${String(statedSplit?.[2])} are checked and ${String(statedSplit?.[3])} are not, and this run reads ${String(messages.length)}, ${String(checked)} and ${String(messages.length - checked)} — change the preamble to the numbers this run produced, which is the whole of the fix when the change was to add or remove a message`,
  ).toEqual([
    String(messages.length),
    String(checked),
    String(messages.length - checked),
  ]);

  expect(
    [statedReasons?.[1], statedReasons?.[2], statedReasons?.[3]],
    `Catalogued messages: ${CATALOGUE}'s preamble says ${String(statedReasons?.[1])} of the unchecked messages are assembled, ${String(statedReasons?.[2])} an excerpt and ${String(statedReasons?.[3])} foreign, and UNCHECKED in ${SELF} lists ${listed("assembled")}, ${listed("excerpt")} and ${listed("foreign")} — change the preamble to the numbers this run produced, which is the whole of the fix when the change was to classify a message`,
  ).toEqual([listed("assembled"), listed("excerpt"), listed("foreign")]);

  expect(
    [statedPinned?.[1], statedPinned?.[2]],
    `Catalogued messages: ${CATALOGUE}'s preamble says the checked messages pin ${String(statedPinned?.[1])} of ${String(statedPinned?.[2])} fenced characters, and this run counts ${String(pinned)} of ${String(fenced)} — change the preamble to the numbers this run produced`,
  ).toEqual([String(pinned), String(fenced)]);
});
