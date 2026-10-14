// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "./app.js";
import Signup from "./components/signup.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface El {
  disabled: boolean;
  click(): void;
  dispatchEvent(event: unknown): boolean;
}
interface Container {
  innerHTML: string;
  remove(): void;
  querySelector(selector: string): El | null;
}
declare const document: {
  createElement(tag: "div"): Container;
  body: { appendChild(node: unknown): void };
};
declare const window: {
  HTMLInputElement: { prototype: object };
  Event: new (type: string, init: { bubbles: boolean }) => unknown;
};

const mounted: { root?: { unmount(): void }; container?: Container } = {};
const requests: string[] = [];

// The island's `fetch`, answered by the app in process: the same request a browser sends to
// `/api/signup` on the site's own origin.
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${input}`);
    return app.fetch(new Request(new URL(input, "http://site.test"), init));
  });
});

afterEach(() => {
  if (mounted.root !== undefined) act(() => mounted.root?.unmount());
  mounted.container?.remove();
  mounted.root = undefined;
  mounted.container = undefined;
  vi.unstubAllGlobals();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

async function hydrated(): Promise<Container> {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Signup />);
  document.body.appendChild(container);
  mounted.container = container;
  await act(async () => {
    mounted.root = hydrateRoot(container, <Signup />);
  });
  return container;
}

// React reads a controlled input's value through the prototype's setter, then an `input` event.
function type(input: El, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function status(container: Container): string | null {
  return (container.querySelector('[role="status"]') as unknown as { textContent: string | null })
    .textContent;
}

async function submit(container: Container, email: string): Promise<void> {
  const input = container.querySelector("input");
  if (input === null) throw new Error("no input rendered");
  await act(async () => type(input, email));
  await act(async () => container.querySelector("button")?.click());
}

test("the server-rendered button is disabled and hydration enables it", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Signup />);
  expect(container.querySelector("button")?.disabled).toBe(true);
  const live = await hydrated();
  expect(live.querySelector("button")?.disabled).toBe(false);
});

test("a submit posts to the app on the same origin and shows its answer", async () => {
  const container = await hydrated();
  await submit(container, "reader@example.com");
  await vi.waitFor(() =>
    expect(status(container)).toBe("Thanks. We will write to reader@example.com."),
  );
  expect(requests).toEqual(["POST /api/signup"]);
});

// A malformed address never leaves the page, since `type="email"` blocks the submit; an empty
// one does, and the app refuses it.
test("the app's refusal is shown as it was sent", async () => {
  const container = await hydrated();
  await submit(container, "");
  await vi.waitFor(() => expect(status(container)).toBe("Enter an email address."));
  expect(requests).toEqual(["POST /api/signup"]);
});
