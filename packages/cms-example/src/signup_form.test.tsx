// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SignupForm from "./components/signup_form.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface El {
  value: string;
  disabled: boolean;
  click(): void;
}
interface Container {
  innerHTML: string;
  textContent: string | null;
  remove(): void;
  querySelector(selector: string): El | null;
}
declare const document: {
  createElement(tag: "div"): Container;
  body: { appendChild(node: unknown): void };
  addEventListener(type: "submit", handler: (event: { defaultPrevented: boolean }) => void): void;
  removeEventListener(type: "submit", handler: (event: never) => void): void;
};
declare const location: { href: string };

const form = (
  <SignupForm label="Email address" button="Sign up" confirmation="Thanks. This sends nothing." />
);

const mounted: { root?: { unmount(): void }; container?: Container } = {};
const fetched: unknown[] = [];
const submits: boolean[] = [];
const recordSubmit = (event: { defaultPrevented: boolean }): void => {
  submits.push(event.defaultPrevented);
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fetched.length = 0;
  submits.length = 0;
  vi.stubGlobal("fetch", (input: unknown) => {
    fetched.push(input);
    return Promise.reject(new Error("no request expected"));
  });
  document.addEventListener("submit", recordSubmit);
});

afterEach(() => {
  if (mounted.root !== undefined) act(() => mounted.root?.unmount());
  mounted.container?.remove();
  mounted.root = undefined;
  mounted.container = undefined;
  document.removeEventListener("submit", recordSubmit);
  vi.unstubAllGlobals();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

test("the server-rendered button is disabled and hydration enables it", async () => {
  const html = renderToString(form);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  mounted.container = container;

  expect(container.querySelector("button")?.disabled).toBe(true);

  await act(async () => {
    mounted.root = hydrateRoot(container, form);
  });

  expect(container.querySelector("button")?.disabled).toBe(false);
});

test("a submit after hydration shows the confirmation, with no navigation and no request", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(form);
  document.body.appendChild(container);
  mounted.container = container;
  await act(async () => {
    mounted.root = hydrateRoot(container, form);
  });
  const page = location.href;

  const input = container.querySelector("input");
  if (input === null) throw new Error("no input rendered");
  input.value = "reader@example.com";
  await act(async () => {
    container.querySelector("button")?.click();
  });

  expect(submits).toEqual([true]);
  expect(container.textContent).toBe("Thanks. This sends nothing.");
  expect(location.href).toBe(page);
  expect(fetched).toEqual([]);
});
