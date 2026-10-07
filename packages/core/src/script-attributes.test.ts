// @vitest-environment jsdom
// The probe is installed by a script in the page: vitest's jsdom environment gives this
// file copies of the window's globals, which the parsed page cannot see.
import { expect, test } from "vitest";
import { scriptElements } from "./script-elements.js";
import { scriptsFaultReport } from "./scripts.js";
import type { ScriptsSetting } from "./scripts.js";

// Declared here rather than adding the `DOM` lib to the workspace tsconfig.
interface TestElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  dispatchEvent(event: object): boolean;
}
declare const document: {
  open(): void;
  write(html: string): void;
  close(): void;
  createElement(tag: string): TestElement;
  querySelector(selector: string): TestElement | null;
};
declare const Event: {
  new (type: string, init?: { bubbles?: boolean }): object;
};

const HOME = { locale: "en", path: "/" };
const SRC = "https://example.com/analytics.js";
const DOMAIN = "example.org";

// `String(...)`, so an element attributed too late records the literal `"null"`.
const PROBE = `(function(){var h=document.head,append=h.appendChild;h.appendChild=function(n){n.setAttribute("data-at-append",String(n.getAttribute("data-domain")));return append.call(h,n)}})()`;

const ANALYTICS: ScriptsSetting = {
  scripts: [
    {
      name: "analytics",
      src: SRC,
      strategy: "idle",
      attributes: { "data-domain": DOMAIN },
    },
  ],
};

const BEHIND_FACADE: ScriptsSetting = {
  scripts: [
    {
      name: "comments",
      src: SRC,
      strategy: "facade",
      facade: { html: '<button id="comments">Show comments</button>' },
      attributes: { "data-domain": DOMAIN },
    },
  ],
};

function render(settings: ScriptsSetting): void {
  const { placeholders, elements } = scriptElements(settings, HOME);
  document.open();
  document.write(
    `<!doctype html><html><body><script>${PROBE}</script><main><p id="content">content</p>\n${placeholders.map(({ html }) => html).join("\n")}</main>\n${elements.join("\n")}</body></html>`,
  );
  document.close();
}

async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function appended(): TestElement {
  const found = document.querySelector(`script[src="${SRC}"]`);
  if (found === null) throw new Error(`${SRC} was never appended`);
  return found;
}

function press(selector: string): void {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`${selector} is not in the document`);
  found.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

test("a declared attribute is on the element the loader appends", async () => {
  render(ANALYTICS);

  await idle();

  expect(appended().getAttribute("data-domain")).toBe(DOMAIN);
});

test("the attribute is on the element before it reaches the document", async () => {
  render(ANALYTICS);

  await idle();

  expect(appended().getAttribute("data-at-append")).toBe(DOMAIN);
});

test("a facade's promoted script is attributed before it reaches the document", async () => {
  render(BEHIND_FACADE);

  press("#comments");

  expect(appended().getAttribute("data-at-append")).toBe(DOMAIN);
});

function* sampledCharacters(): Generator<string> {
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield String.fromCodePoint(cp);
  }
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 0x40) yield String.fromCodePoint(cp);
  for (const cp of [0x10000, 0xeffff, 0xf0000, 0x10fffe, 0x10ffff]) {
    yield String.fromCodePoint(cp);
  }
}

test("the config door refuses exactly the names setAttribute refuses", () => {
  const element = document.createElement("script");
  const browserRefuses = (key: string): boolean => {
    try {
      element.setAttribute(key, "x");
      element.removeAttribute(key);
      return false;
    } catch {
      return true;
    }
  };
  const doorRefuses = (key: string): boolean =>
    scriptsFaultReport(
      { scripts: [{ name: "analytics", src: SRC, attributes: { [key]: "x" } }] },
      "Script settings",
    ) !== undefined;

  const disagreements: string[] = [];
  let checked = 0;
  for (const char of sampledCharacters()) {
    const key = `data-${char}`;
    checked += 1;
    if (doorRefuses(key) !== browserRefuses(key)) {
      const cp = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
      disagreements.push(`U+${cp.padStart(4, "0")}`);
    }
  }

  expect(disagreements).toEqual([]);
  expect(checked).toBe(79_877);
});

test("a lone surrogate is refused at the door and at setAttribute alike", () => {
  const element = document.createElement("script");

  expect(() => {
    element.setAttribute("data-\ud800", "x");
  }).toThrow();
  expect(
    scriptsFaultReport(
      {
        scripts: [
          { name: "analytics", src: SRC, attributes: { "data-\ud800": "x" } },
        ],
      },
      "Script settings",
    ),
  ).toContain("a name setAttribute throws on");
});
