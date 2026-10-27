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
  value: string;
  click(): void;
  getAttribute(name: string): string | null;
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
const requests: { method: string; url: string; accept: string | null; email: unknown }[] = [];

type Answer = (request: Request) => Promise<Response>;

// The island's `fetch`, answered by the app in process: the same request a browser sends to
// `/api/signup` on the site's own origin, `Origin` included.
const byTheApp: Answer = (request) => Promise.resolve(app.fetch(request));
let answer: Answer = byTheApp;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  answer = byTheApp;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    // jsdom's `FormData` is not one Node's `Request` can encode, so its fields go urlencoded.
    const body = new URLSearchParams(init?.body as unknown as Iterable<[string, string]>).toString();
    const request = new Request(new URL(input, "http://site.test"), { ...init, body });
    request.headers.set("Content-Type", "application/x-www-form-urlencoded");
    request.headers.set("Origin", "http://site.test");
    requests.push({
      method: request.method,
      url: new URL(request.url).pathname,
      accept: request.headers.get("Accept"),
      email: await request.clone().formData().then((form) => form.get("email"), () => undefined),
    });
    return answer(request);
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

function the(container: Container, selector: string): El {
  const element = container.querySelector(selector);
  if (element === null) throw new Error(`no ${selector} rendered`);
  return element;
}

function status(container: Container): string | null {
  return (the(container, '[role="status"]') as unknown as { textContent: string | null }).textContent;
}

async function submit(container: Container, email: string): Promise<void> {
  await act(async () => type(the(container, "input"), email));
  await act(async () => the(container, "button").click());
}

function held(): { answer: Answer; release(response: Response): void } {
  let release: (response: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => (release = resolve));
  return { answer: () => response, release: (value) => release(value) };
}

const FAILED = "Something went wrong, so you are not signed up yet. Your address is still in the form: try again.";

test("before hydration the form is a POST to the app, so a submit never puts the address in a URL", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Signup />);
  const form = the(container, "form");
  expect(form.getAttribute("method")).toBe("post");
  expect(form.getAttribute("action")).toBe("/api/signup");
  expect(the(container, "input").getAttribute("name")).toBe("email");
  expect(the(container, "button").disabled).toBe(false);
});

test("a submit posts the form to the app on the same origin and shows its answer", async () => {
  const container = await hydrated();
  await submit(container, "reader@example.com");
  await vi.waitFor(() =>
    expect(status(container)).toBe("Thanks. We will write to reader@example.com."),
  );
  expect(requests).toEqual([
    { method: "POST", url: "/api/signup", accept: "application/json", email: "reader@example.com" },
  ]);
});

test("while the request is out the form says so, and a second submit sends nothing", async () => {
  const container = await hydrated();
  const slow = held();
  answer = slow.answer;
  await submit(container, "reader@example.com");
  expect(status(container)).toBe("Signing up…");
  expect(the(container, "form").getAttribute("aria-busy")).toBe("true");
  expect(the(container, "button").getAttribute("aria-disabled")).toBe("true");
  await act(async () => the(container, "button").click());
  await act(async () => the(container, "button").click());
  expect(requests).toHaveLength(1);

  await act(async () =>
    slow.release(
      Response.json({ message: "Thanks. We will write to reader@example.com." }, { status: 201 }),
    ),
  );
  await vi.waitFor(() =>
    expect(status(container)).toBe("Thanks. We will write to reader@example.com."),
  );
  expect(the(container, "button").getAttribute("aria-disabled")).toBe("false");
});

// A malformed address never leaves the page, since `type="email"` blocks the submit; an empty
// one does, and the app refuses it.
test("the app's refusal is shown against the field, and the field keeps what was typed", async () => {
  const container = await hydrated();
  await submit(container, "");
  await vi.waitFor(() => expect(status(container)).toBe("Enter an email address."));
  const input = the(container, "input");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe(the(container, '[role="status"]').getAttribute("id"));
  expect(requests).toHaveLength(1);
});

test("an answer that is not the app's JSON is a failure, and its body never reaches the page", async () => {
  const container = await hydrated();
  answer = () =>
    Promise.resolve(
      new Response("<h1>502</h1><p>upstream token=s3cr3t at 10.0.0.7</p>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );
  await submit(container, "reader@example.com");
  await vi.waitFor(() => expect(status(container)).toBe(FAILED));
  expect(container.innerHTML).not.toContain("s3cr3t");
  expect(the(container, "input").value).toBe("reader@example.com");

  answer = byTheApp;
  await act(async () => the(container, "button").click());
  await vi.waitFor(() =>
    expect(status(container)).toBe("Thanks. We will write to reader@example.com."),
  );
  expect(requests).toHaveLength(2);
});

test("a request that never reaches the app is a failure the reader can retry", async () => {
  const container = await hydrated();
  answer = () => Promise.reject(new TypeError("Failed to fetch"));
  await submit(container, "reader@example.com");
  await vi.waitFor(() => expect(status(container)).toBe(FAILED));
  expect(the(container, "input").value).toBe("reader@example.com");

  answer = byTheApp;
  await act(async () => the(container, "button").click());
  await vi.waitFor(() =>
    expect(status(container)).toBe("Thanks. We will write to reader@example.com."),
  );
});
