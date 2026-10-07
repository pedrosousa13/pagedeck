// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONSENT_EVENT, CONSENT_GLOBAL } from "@pagedeck/core/consent";
import ConsentBanner, {
  CONSENT_BANNER_STORAGE_KEY,
} from "@pagedeck/design-system/components/consent_banner";
import type { ComponentType } from "react";
import type { ConsentSource } from "@pagedeck/core/consent";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface Pressable {
  id: string;
  click(): void;
  textContent: string | null;
  getAttribute(name: string): string | null;
}
interface Container {
  innerHTML: string;
  remove(): void;
  querySelector(selector: string): Pressable | null;
  querySelectorAll(selector: string): ArrayLike<Pressable>;
}
declare const document: {
  createElement(tag: "div"): Container;
  body: { appendChild(node: unknown): void };
  activeElement: { id: string } | null;
};
declare const localStorage: {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const listeners = globalThis as unknown as {
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
};
const installed = globalThis as unknown as Record<
  string,
  ConsentSource | undefined
>;

const COPY = {
  heading: "Cookies on this site",
  body: "We use cookies to measure how the site is used.",
  acceptLabel: "Accept all",
  rejectLabel: "Reject all",
  manageLabel: "Cookie settings",
} as const;

const Banner = ConsentBanner as unknown as ComponentType<
  Record<string, unknown>
>;

function markup(props: Record<string, unknown> = COPY): string {
  return renderToStaticMarkup(createElement(Banner, props));
}

interface Mounted {
  container: Container;
  button(name: "accept" | "reject" | "manage"): Pressable;
  press(name: "accept" | "reject" | "manage"): void;
}

const mounted: { root?: { unmount(): void }; container?: Container } = {};

// Hydrated over its own server markup, as on a real page, and attached to the
// document, because `.focus()` on a detached node is silently a no-op.
function mount(props: Record<string, unknown> = COPY): Mounted {
  const container = document.createElement("div");
  container.innerHTML = markup(props);
  document.body.appendChild(container);
  act(() => {
    mounted.root = hydrateRoot(
      container as never,
      createElement(Banner, props),
    );
  });
  mounted.container = container;

  const button = (name: "accept" | "reject" | "manage"): Pressable => {
    const found = container.querySelector(`.consent-banner__${name}`);
    if (found === null) {
      throw new Error(
        `the banner renders no "${name}" button — it holds ${container.innerHTML}`,
      );
    }
    return found;
  };
  return {
    container,
    button,
    press: (name) => {
      act(() => {
        button(name).click();
      });
    },
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  delete installed[CONSENT_GLOBAL];
});

afterEach(() => {
  if (mounted.root !== undefined) act(() => mounted.root?.unmount());
  mounted.container?.remove();
  mounted.root = undefined;
  mounted.container = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  delete installed[CONSENT_GLOBAL];
  vi.restoreAllMocks();
});

test("the whole banner is markup the server renders with no script behind it", () => {
  const html = markup();

  expect(html).toContain(COPY.heading);
  expect(html).toContain(COPY.body);
  expect(html).toContain(COPY.acceptLabel);
  expect(html).toContain(COPY.rejectLabel);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("://");
});

test("both choices are real buttons a keyboard reaches", () => {
  const html = markup();

  // Attribute by attribute: their order is React's and may change in a release.
  for (const choice of ["accept", "reject"] as const) {
    expect(html).toMatch(
      new RegExp(`<button [^>]*class="consent-banner__${choice}"`),
    );
  }
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(
    (match) => match[0],
  );
  expect(buttons.length).toBe(2);
  for (const button of buttons) expect(button).toContain('type="button"');
});

test("the banner is a named region rather than an unlabelled box", () => {
  const html = markup();

  expect(html).toMatch(/<section [^>]*role="region"/);
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
  expect(labelledBy).toBeDefined();
  expect(html).toContain(`id="${labelledBy ?? ""}"`);
  expect(html).toMatch(
    new RegExp(`id="${labelledBy ?? ""}"[^>]*>${COPY.heading}`),
  );
});

test("copy the banner cannot render an accessible name from is refused", () => {
  expect(() => markup({ ...COPY, acceptLabel: "", manageLabel: undefined }))
    .toThrowError(/acceptLabel[\s\S]*manageLabel/);
});

test("no consent source is installed until the visitor has answered", () => {
  mount();

  expect(installed[CONSENT_GLOBAL]).toBeUndefined();
});

test("accepting installs a source that grants every category", () => {
  const banner = mount();
  const changes: number[] = [];
  const onChange = (): void => {
    changes.push(1);
  };
  listeners.addEventListener(CONSENT_EVENT, onChange);

  banner.press("accept");

  const source = installed[CONSENT_GLOBAL];
  expect(source).toBeDefined();
  expect(source?.granted("analytics")).toBe(true);
  expect(source?.granted("functional")).toBe(true);
  expect(source?.granted("marketing")).toBe(true);
  expect(source?.granted("necessary")).toBe(true);
  expect(changes.length).toBe(1);
  listeners.removeEventListener(CONSENT_EVENT, onChange);
});

test("rejecting installs a source that denies all but the necessary category", () => {
  const banner = mount();

  banner.press("reject");

  const source = installed[CONSENT_GLOBAL];
  expect(source?.granted("analytics")).toBe(false);
  expect(source?.granted("functional")).toBe(false);
  expect(source?.granted("marketing")).toBe(false);
  expect(source?.granted("necessary")).toBe(true);
});

test("a visitor who accepts and then revokes gets a source that denies", () => {
  const banner = mount();
  const changes: number[] = [];
  const onChange = (): void => {
    changes.push(1);
  };
  listeners.addEventListener(CONSENT_EVENT, onChange);

  banner.press("accept");
  banner.press("manage");
  banner.press("reject");

  expect(installed[CONSENT_GLOBAL]?.granted("analytics")).toBe(false);
  expect(changes.length).toBe(2);
  listeners.removeEventListener(CONSENT_EVENT, onChange);
});

test("the reference a caller kept answers the decision after it", () => {
  // The framework's gate re-reads the global, so only a holder of the object can
  // tell a source replaced per decision from a live one.
  const banner = mount();

  banner.press("accept");
  const held = installed[CONSENT_GLOBAL];
  banner.press("manage");
  banner.press("reject");

  expect(installed[CONSENT_GLOBAL]).toBe(held);
  expect(held?.granted("analytics")).toBe(false);
});

test("a decision the visitor already made installs the source without being asked again", () => {
  localStorage.setItem(
    CONSENT_BANNER_STORAGE_KEY,
    JSON.stringify({ analytics: true, functional: false, marketing: false }),
  );

  const banner = mount();

  expect(installed[CONSENT_GLOBAL]?.granted("analytics")).toBe(true);
  expect(installed[CONSENT_GLOBAL]?.granted("functional")).toBe(false);
  expect(installed[CONSENT_GLOBAL]?.granted("marketing")).toBe(false);
  expect(banner.container.querySelector(".consent-banner__accept")).toBeNull();
  expect(banner.button("manage")).toBeDefined();
});

test("a decision recorded before the banner asked about functional is asked again", () => {
  localStorage.setItem(
    CONSENT_BANNER_STORAGE_KEY,
    JSON.stringify({ analytics: true, marketing: true }),
  );

  const banner = mount();

  expect(installed[CONSENT_GLOBAL]).toBeUndefined();
  expect(banner.button("accept")).toBeDefined();
  expect(banner.button("reject")).toBeDefined();
});

test("answering moves focus to the control that replaces the buttons", () => {
  const banner = mount();

  banner.press("accept");
  expect(document.activeElement?.id).toBe(banner.button("manage").id);

  banner.press("manage");
  expect(document.activeElement?.id).toBe(banner.button("accept").id);
});

test("a stored decision does not steal focus on arrival", () => {
  localStorage.setItem(
    CONSENT_BANNER_STORAGE_KEY,
    JSON.stringify({ analytics: true, functional: true, marketing: true }),
  );

  const banner = mount();

  expect(document.activeElement?.id).not.toBe(banner.button("manage").id);
});
