// @vitest-environment jsdom
// `document.write`, not `innerHTML`: a script inserted by `innerHTML` never runs, so
// only the parser executes the loader.
import { expect, test } from "vitest";
import { scriptElements } from "./script-elements.js";
import type { ScriptsSetting } from "./scripts.js";

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface TestElement {
  readonly textContent: string | null;
  dispatchEvent(event: object): boolean;
}
declare const document: {
  open(): void;
  write(html: string): void;
  close(): void;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): ArrayLike<TestElement>;
};
declare const Event: {
  new (type: string, init?: { bubbles?: boolean }): object;
};

const HOME = { locale: "en", path: "/" };
const CHAT_SRC = "https://example.com/c.js";

const CHAT: ScriptsSetting = {
  scripts: [
    {
      name: "chat",
      src: CHAT_SRC,
      strategy: "facade",
      facade: { html: '<button id="chat">Chat</button>' },
    },
  ],
};

function render(settings: ScriptsSetting): void {
  const { placeholders, elements } = scriptElements(settings, HOME);
  document.open();
  document.write(
    `<!doctype html><html><body><main><p id="content">content</p>\n${placeholders.map(({ html }) => html).join("\n")}</main>\n${elements.join("\n")}</body></html>`,
  );
  document.close();
}

function element(selector: string): TestElement {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`${selector} is not in the document`);
  return found;
}

function loaded(src: string): number {
  return document.querySelectorAll(`script[src="${src}"]`).length;
}

function press(selector: string): void {
  element(selector).dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

test("the placeholder is in the document and the script it fronts is not", () => {
  render(CHAT);

  expect(element("#chat").textContent).toBe("Chat");
  expect(loaded(CHAT_SRC)).toBe(0);
});

test("pressing the placeholder is what loads the real script", () => {
  render(CHAT);

  expect(loaded(CHAT_SRC)).toBe(0);
  press("#chat");
  expect(loaded(CHAT_SRC)).toBe(1);

  press("#chat");
  expect(loaded(CHAT_SRC)).toBe(1);
});

test("interacting anywhere else on the page does not load a facade's script", () => {
  render(CHAT);
  expect(element("#chat").textContent).toBe("Chat");

  press("#content");

  expect(loaded(CHAT_SRC)).toBe(0);
});

test("the placeholder is removed once the script it fronts has loaded", () => {
  render(CHAT);
  press("#chat");

  expect(document.querySelector("#chat")).not.toBeNull();

  element(`script[src="${CHAT_SRC}"]`).dispatchEvent(new Event("load"));
  expect(document.querySelector("#chat")).toBeNull();
});

test("two facades on one page are promoted independently", () => {
  const video = "https://example.com/v.js";
  render({
    scripts: [
      ...CHAT.scripts,
      {
        name: "video",
        src: video,
        strategy: "facade",
        facade: { html: '<button id="video">Play</button>' },
      },
    ],
  });

  press("#video");

  expect(loaded(video)).toBe(1);
  expect(loaded(CHAT_SRC)).toBe(0);
});

test("a facade whose markup names another facade's key does not take its placeholder", () => {
  const video = "https://example.com/v.js";
  render({
    scripts: [
      {
        name: "chat",
        src: CHAT_SRC,
        strategy: "facade",
        facade: { html: '<button id="chat" data-fw-facade="1">Chat</button>' },
      },
      {
        name: "video",
        src: video,
        strategy: "facade",
        facade: { html: '<button id="video">Play</button>' },
      },
    ],
  });

  press("#video");
  expect(loaded(video)).toBe(1);
  expect(loaded(CHAT_SRC)).toBe(0);

  press("#chat");
  expect(loaded(CHAT_SRC)).toBe(1);
  expect(loaded(video)).toBe(1);
});
