// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import LandingPage from "@pagedeck/design-system/components/landing_page";
import type { ComponentType } from "react";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface Node {
  id: string;
  tagName: string;
  textContent: string | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): Node | null;
  click(): void;
}
interface Container {
  innerHTML: string;
  remove(): void;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): ArrayLike<Node>;
}
declare const document: {
  createElement(tag: "div"): Container;
  body: { appendChild(node: unknown): void };
};

const Landing = LandingPage as unknown as ComponentType<
  Record<string, unknown>
>;

// Not English, so copy the template spelled itself would show up here.
const FIELDS = {
  headline: "Komm zu uns",
  email_label: "E-Mail-Adresse",
  apply_label: "Bewerben",
  send_label: "Senden",
};

const mounted: { root?: { unmount(): void }; container?: Container } = {};

function opened(fields: Record<string, unknown>): Container {
  const props = { fields };
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(Landing, props));
  document.body.appendChild(container);
  act(() => {
    mounted.root = hydrateRoot(
      container as never,
      createElement(Landing, props),
    );
  });
  mounted.container = container;
  act(() => {
    container.querySelector("button")?.click();
  });
  return container;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mounted.root !== undefined) act(() => mounted.root?.unmount());
  mounted.container?.remove();
  mounted.root = undefined;
  mounted.container = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

test("the email input is named by a visible label holding the content's text", () => {
  const container = opened(FIELDS);
  const input = container.querySelector('input[name="email"]');
  expect(input, container.innerHTML).not.toBeNull();

  const byFor =
    input?.id === "" || input === null
      ? null
      : container.querySelector(`label[for="${input.id}"]`);
  const label = byFor ?? input?.closest("label") ?? null;
  expect(label, container.innerHTML).not.toBeNull();
  expect(label?.textContent?.trim()).toBe(FIELDS.email_label);

  expect(label?.hasAttribute("hidden")).toBe(false);
  expect(label?.getAttribute("class") ?? "").not.toMatch(/sr-only|hidden/);
});

test("both buttons carry the content's text, not the template's", () => {
  const container = opened(FIELDS);
  const buttons = Array.from(container.querySelectorAll("button")).map(
    (button) => button.textContent,
  );
  expect(buttons).toEqual([FIELDS.apply_label, FIELDS.send_label]);
});

function serverRender(fields: Record<string, unknown>): () => string {
  return () => renderToStaticMarkup(createElement(Landing, { fields }));
}

test("content with no email label is refused rather than rendered unlabelled", () => {
  for (const email_label of [undefined, "", "   "]) {
    expect(
      serverRender({ ...FIELDS, headline: "Join us", email_label }),
    ).toThrow(/LandingPage "Join us"[\s\S]*email_label/);
  }
});

test("every missing copy field is named in one refusal", () => {
  let message = "";
  try {
    serverRender({ headline: "Join us" })();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/^LandingPage "Join us": 3 copy fields are missing/);
  expect(message).toMatch(
    /\n {2}email_label\n {2}apply_label\n {2}send_label$/,
  );
});

test("an entry with no headline is refused without naming it undefined", () => {
  expect(
    serverRender({ ...FIELDS, headline: undefined, send_label: " " }),
  ).toThrow(
    /^LandingPage with no headline: 1 copy field is missing[\s\S]*send_label/,
  );
});
