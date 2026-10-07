// @vitest-environment jsdom
import { expect, test } from "vitest";
import { scriptElements } from "./script-elements.js";
import type { ScriptDeclaration, ScriptsSetting } from "./scripts.js";

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface TestElement {
  getAttribute(name: string): string | null;
  dispatchEvent(event: object): boolean;
}
declare const document: {
  open(): void;
  write(html: string): void;
  close(): void;
  querySelector(selector: string): TestElement | null;
};
declare const Event: {
  new (type: string, init?: { bubbles?: boolean }): object;
};

const HOME = { locale: "en", path: "/" };
const SRC = "https://cdn.example.com/widget@1.2.3/widget.min.js";
const INTEGRITY =
  "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC";

// Records the `integrity` attribute, not the property: jsdom does not reflect it.
const PROBE = `(function(){var h=document.head,append=h.appendChild;h.appendChild=function(n){n.setAttribute("data-at-append",String(n.getAttribute("integrity"))+" "+String(n.crossOrigin));return append.call(h,n)}})()`;

function widget(extra: Partial<ScriptDeclaration>): ScriptDeclaration {
  return { name: "widget", src: SRC, integrity: INTEGRITY, ...extra };
}

function render(settings: ScriptsSetting): void {
  const { placeholders, elements } = scriptElements(settings, HOME);
  document.open();
  document.write(
    `<!doctype html><html><body><script>${PROBE}</script><main><p id="content">content</p>\n${placeholders.map(({ html }) => html).join("\n")}</main>\n${elements.join("\n")}</body></html>`,
  );
  document.close();
}

/** Let the `idle` half's `setTimeout` fallback run — jsdom has no `requestIdleCallback`. */
async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function appended(): TestElement {
  const found = document.querySelector(`script[src="${SRC}"]`);
  if (found === null) throw new Error(`${SRC} was never appended`);
  return found;
}

test("an idle script is given its integrity and CORS mode before it reaches the document", async () => {
  render({ scripts: [widget({ strategy: "idle" })] });

  await idle();

  expect(appended().getAttribute("data-at-append")).toBe(
    `${INTEGRITY} anonymous`,
  );
});

test("a gated script is given them before it reaches the document", async () => {
  render({
    scripts: [widget({ strategy: "idle", category: "analytics" })],
    consentDefaults: { "en:/**": { analytics: "granted" } },
  });

  await idle();

  expect(appended().getAttribute("data-at-append")).toBe(
    `${INTEGRITY} anonymous`,
  );
});

test("a facade's promoted script is given them before it reaches the document", () => {
  render({
    scripts: [
      widget({
        strategy: "facade",
        facade: { html: '<button id="widget">Show widget</button>' },
      }),
    ],
  });

  const button = document.querySelector("#widget");
  if (button === null) throw new Error("#widget is not in the document");
  button.dispatchEvent(new Event("pointerdown", { bubbles: true }));

  expect(appended().getAttribute("data-at-append")).toBe(
    `${INTEGRITY} anonymous`,
  );
});

test("a script declaring no integrity is appended with neither", async () => {
  render({ scripts: [{ name: "widget", src: SRC, strategy: "idle" }] });

  await idle();

  expect(appended().getAttribute("data-at-append")).toBe("null null");
});
