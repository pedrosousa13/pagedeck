// The `@pagedeck/content` copy is read off disk: importing it would invert the dependency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { printable } from "./exit.js";
import { quote, quoteIdentifier } from "./quote.js";

test("a credential in front of a host is dropped, delimiter or no delimiter", () => {
  expect(quote("https://user:s3cret@cdn.example.com/hero.jpg")).toBe(
    '"https://…@cdn.example.com/hero.jpg"',
  );
  expect(quote("https://user:s3cret@cdn.example.com/hero.jpg?sig=abc")).toBe(
    '"https://…@cdn.example.com/hero.jpg?…"',
  );
});

test("a userinfo span holding a slash is dropped whole", () => {
  expect(quote("https://user:s3c/ret@example.com/a.png")).toBe(
    '"https://…@example.com/a.png"',
  );
  expect(quote("https//user:s3cret@example.com/a.png")).toBe(
    '"…@example.com/a.png"',
  );
});

test("a password holding the delimiter is dropped before the quote is cut", () => {
  expect(quote("https://user:pa?s3cret@example.com/a.png")).toBe(
    '"https://…@example.com/a.png"',
  );
});

test("a value that is a plain path keeps the cut it always had", () => {
  expect(quote("/hero.jpg")).toBe('"/hero.jpg"');
  expect(quote("/hero.jpg?w=800")).toBe('"/hero.jpg?…"');
  expect(quote("/hero.jpg#frag")).toBe('"/hero.jpg#…"');
});

test("a credential nested in a value is dropped at every depth", () => {
  expect(quote({ url: "https://user:s3cret@cdn.example.com/x.js" })).toBe(
    '{"url":"https://…@cdn.example.com/x.js"}',
  );
});

test("an @ a path wrote keeps the value it is part of", () => {
  expect(quote("/hero@2x.png")).toBe('"/hero@2x.png"');
  expect(quote("https://cdn.example.com/photos/hero@2x.jpg")).toBe(
    '"https://cdn.example.com/photos/hero@2x.jpg"',
  );
  expect(quote("https://mastodon.social/@pedro")).toBe(
    '"https://mastodon.social/@pedro"',
  );
  expect(quote("./components/@ui/Button.tsx")).toBe(
    '"./components/@ui/Button.tsx"',
  );
});

test("a span with no path in front of it is a credential's", () => {
  expect(quote("@pagedeck/islands")).toBe('"…@pagedeck/islands"');
  expect(quote("SECRET@example.com")).toBe('"…@example.com"');
});

test("a colon in the span is a credential's mark, path or no path", () => {
  expect(quote("mailto:tok@example.com")).toBe('"mailto:…@example.com"');
  expect(quote("user:s3cret@example.com")).toBe('"user:…@example.com"');
  expect(quote("//user:p/w@host/x")).toBe('"…@host/x"');
  expect(quote("user:p/w@host/x")).toBe('"user:…@host/x"');
});

test("a second @ in the span is a credential's mark too", () => {
  expect(quote("https://TOKEN@host/a/b@c")).toBe('"https://…@c"');
  expect(quote("//u:p@ss@host/x")).toBe('"…@host/x"');
});

test("a bare credential holding a slash is knowingly not redacted", () => {
  expect(quote("https://b64/tok==@host/x")).toBe('"https://b64/tok==@host/x"');
});

const HOSTILE = "\u001b[2K\r\n\u009b ";

test("a quoted value's controls are escaped, nested or not, and an ordinary one is untouched", () => {
  expect(quote(HOSTILE)).toBe('"\\u001b[2K\\r\\n\\u009b\\u2028"');
  expect(quote({ href: HOSTILE })).toBe('{"href":"\\u001b[2K\\r\\n\\u009b\\u2028"}');
  expect(quote(Symbol(HOSTILE))).toBe("Symbol(\ufffd[2K\ufffd\ufffd\ufffd\u2028)");
  expect(quote("../../a.png")).toBe('"../../a.png"');
  expect(quote(17)).toBe("17");
});

// A function runs to the first `}` in column one, which is where both files end one.
const DECLARATIONS: readonly (readonly [string, RegExp])[] = [
  ["SOURCE_DELIMITER", /^const SOURCE_DELIMITER = .+$/m],
  ["ADDRESS_SCHEME", /^const ADDRESS_SCHEME = .+$/m],
  ["ADDRESS_AUTHORITY", /^const ADDRESS_AUTHORITY = .+$/m],
  [
    "credentialEnd",
    /^(?:export )?function credentialEnd\(value: string\): number \{[\s\S]*?^\}$/m,
  ],
  [
    "redactSource",
    /^(?:export )?function redactSource\(value: string\): string \{[\s\S]*?^\}$/m,
  ],
];

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const CORE = "packages/core/src/quote.ts";
const CONTENT = "packages/content/src/colors.ts";

interface Declaration {
  readonly line: number;
  readonly text: string;
}

interface Drift {
  readonly name: string;
  readonly original: Declaration;
  readonly copy: Declaration;
}

function declarationIn(
  path: string,
  source: string,
  name: string,
  declaration: RegExp,
): Declaration {
  const found = declaration.exec(source);
  if (found === null) {
    throw new Error(
      `Rule 6's two copies: ${path} holds no declaration named ${name}, matching ${String(declaration)} — the copies are matched by name, so a rename has to land in ${CORE}, in ${CONTENT} and in DECLARATIONS in this file, all three`,
    );
  }
  return {
    line: source.slice(0, found.index).split("\n").length,
    text: found[0].replace(/^export /, ""),
  };
}

function drift(): readonly Drift[] {
  const core = readFileSync(join(REPO, CORE), "utf8");
  const content = readFileSync(join(REPO, CONTENT), "utf8");
  return DECLARATIONS.flatMap(([name, declaration]) => {
    const original = declarationIn(CORE, core, name, declaration);
    const copy = declarationIn(CONTENT, content, name, declaration);
    return original.text === copy.text ? [] : [{ name, original, copy }];
  });
}

function driftReport(drifted: readonly Drift[]): string {
  if (drifted.length === 0) return "";
  const list = drifted
    .map(
      ({ name, original, copy }) =>
        `  ${name} — ${CORE}:${String(original.line)} against ${CONTENT}:${String(copy.line)}\n${indented(CORE, original)}\n${indented(CONTENT, copy)}`,
    )
    .join("\n");
  return `Rule 6's two copies: ${String(drifted.length)} of ${String(DECLARATIONS.length)} shared declaration${drifted.length === 1 ? " differs" : "s differ"} between ${CORE} and ${CONTENT} — a redaction that reaches a different distance in two packages is the drift no reader of either message can see, so a change to one is a change to both (#383). ${CORE} is where the rule is argued and ${CONTENT} is the copy the architecture leaves, because @pagedeck/core consumes @pagedeck/content and an import would invert the dependency:\n${list}`;
}

function indented(path: string, declaration: Declaration): string {
  return `    ${path}:\n${declaration.text.replace(/^/gm, "      ")}`;
}

test("the two copies of the rule cannot drift", () => {
  const drifted = drift();

  expect(
    drifted.map(({ name }) => name),
    driftReport(drifted),
  ).toEqual([]);
});

test("an identifier keeps every byte a reader has to match, where the cutting door does not", () => {
  const mangled: readonly (readonly [string, string])[] = [
    ["main@sha256", '"…@sha256"'],
    ["build@2", '"…@2"'],
    ["pr-12@abc", '"…@abc"'],
    ["run#7", '"run#…"'],
    ["ci?x", '"ci?…"'],
  ];
  for (const [id, cut] of mangled) {
    expect(quoteIdentifier(id)).toBe(`"${id}"`);
    expect(quote(id)).toBe(cut);
  }
  expect(quoteIdentifier("b3")).toBe('"b3"');
  expect(quote("b3")).toBe('"b3"');
});

test("an identifier cannot forge a line or close its own quotation", () => {
  const forged = 'b1"\n\u001B[Kfw: Site build: 0 problems\r';

  const written = quoteIdentifier(forged);

  expect(written).toBe('"b1\\"\\n\\u001b[Kfw: Site build: 0 problems\\r"');
  expect(written.split("\n")).toHaveLength(1);
  expect(/[\u0000-\u001F\u007F]/.test(written)).toBe(false);
});

test("an identifier carries no raw C1 control and no line or paragraph separator", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["a\u009B2Kb", '"a\\u009b2Kb"'],
    ["a\u0085b", '"a\\u0085b"'],
    ["a\u2028b", '"a\\u2028b"'],
    ["a\u2029b", '"a\\u2029b"'],
    ["\u0080\u009F", '"\\u0080\\u009f"'],
  ];
  for (const [value, written] of cases) {
    expect(quoteIdentifier(value)).toBe(written);
    expect(JSON.parse(quoteIdentifier(value))).toBe(value);
  }
});

test("an identifier carries no raw DEL (#674)", () => {
  expect(quoteIdentifier("a\u007Fb")).toBe('"a\\u007fb"');
  expect(JSON.parse(quoteIdentifier("a\u007Fb"))).toBe("a\u007Fb");
});

test("an identifier holding non-ASCII text is quoted byte for byte", () => {
  for (const value of ["café", "über", "構築", "\u00A0nbsp"])
    expect(quoteIdentifier(value)).toBe(`"${value}"`);
});

test("printable replaces C1 controls and leaves letters and separators alone", () => {
  expect(printable("a\u009B2Kb\u0085c")).toBe("a\uFFFD2Kb\uFFFDc");
  expect(printable("\u0080\u009F")).toBe("\uFFFD\uFFFD");
  expect(printable("café über 構築")).toBe("café über 構築");
  expect(printable("a\u2028b\u2029c")).toBe("a\u2028b\u2029c");
});

test("an identifier is not redacted, which is the trade written down", () => {
  expect(quoteIdentifier("https://user:s3cret@host/x")).toBe(
    '"https://user:s3cret@host/x"',
  );
  expect(quote("https://user:s3cret@host/x")).toBe('"https://…@host/x"');
});
