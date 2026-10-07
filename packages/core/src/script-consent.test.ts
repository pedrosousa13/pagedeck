// @vitest-environment jsdom
// The consent source is installed by a script in the page: vitest's jsdom environment
// gives this file copies of the window's globals, which the parsed page cannot see.
import { expect, test } from "vitest";
import { scriptElements } from "./script-elements.js";
import {
  CONSENT_ATTRIBUTE,
  CONSENT_EVENT,
  CONSENT_GLOBAL,
} from "./consent.js";
import type { ConsentCategory } from "./consent.js";
import type { ScriptsSetting } from "./scripts.js";

// Declared here rather than adding the `DOM` lib to the workspace tsconfig.
interface TestElement {
  getAttribute(name: string): string | null;
  dispatchEvent(event: object): boolean;
}
interface TestScript {
  textContent: string;
}
declare const document: {
  open(): void;
  write(html: string): void;
  close(): void;
  createElement(tag: "script"): TestScript;
  readonly body: { appendChild(node: TestScript): void };
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): ArrayLike<TestElement>;
};
declare const Event: {
  new (type: string, init?: { bubbles?: boolean }): object;
};

const HOME = { locale: "en", path: "/home" };
const DE_HOME = { locale: "de", path: "/home" };
const PIXEL_SRC = "https://example.com/pixel.js";
const CONSENT_SRC = "https://example.com/cmp.js";

const PIXEL: ScriptsSetting = {
  scripts: [
    {
      name: "pixel",
      src: PIXEL_SRC,
      strategy: "idle",
      category: "analytics",
    },
  ],
};

// `document.open()` replaces the document, not the window, so without this a grant in
// one test fires the gate the previous test left armed.
const RESET = `(function(){var w=window;var l=w.__fwListeners;if(l)for(var i=0;i<l.length;i++)w.removeEventListener(l[i][0],l[i][1]);w.__fwListeners=[];if(!w.__fwPatched){w.__fwPatched=1;var add=w.addEventListener;w.addEventListener=function(t,f,o){w.__fwListeners.push([t,f]);return add.call(w,t,f,o)}}delete w.${CONSENT_GLOBAL}})()`;

function render(
  settings: ScriptsSetting,
  page = HOME,
  before: readonly string[] = [],
): void {
  const { placeholders, elements } = scriptElements(settings, page);
  document.open();
  document.write(
    `<!doctype html><html><body><script>${RESET}</script>${before
      .map((source) => `<script>${source}</script>`)
      .join(
        "",
      )}<main><p id="content">content</p>\n${placeholders.map(({ html }) => html).join("\n")}</main>\n${elements.join("\n")}</body></html>`,
  );
  document.close();
}

function inPage(source: string): void {
  const script = document.createElement("script");
  script.textContent = source;
  document.body.appendChild(script);
}

function loaded(src: string): number {
  return document.querySelectorAll(`script[src="${src}"]`).length;
}

function consent(...granted: readonly ConsentCategory[]): void {
  inPage(
    `window.${CONSENT_GLOBAL}={granted:function(c){return ${JSON.stringify(granted)}.indexOf(c)>=0}};` +
      `window.dispatchEvent(new Event(${JSON.stringify(CONSENT_EVENT)}))`,
  );
}

async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function press(selector: string): void {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`${selector} is not in the document`);
  found.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

test("a categorized script does not load when its trigger fires without consent", async () => {
  render(PIXEL);

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(0);
});

test("a grant loads the script the trigger already fired for", async () => {
  render(PIXEL);
  await idle();
  expect(loaded(PIXEL_SRC)).toBe(0);

  consent("analytics");

  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a functional script loads at a grant of functional, and not at a grant of the others", async () => {
  render({
    scripts: [
      {
        name: "player",
        src: PIXEL_SRC,
        strategy: "idle",
        category: "functional",
      },
    ],
  });
  await idle();

  consent("analytics", "marketing");
  expect(loaded(PIXEL_SRC)).toBe(0);

  consent("functional");
  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a grant does not load a script whose strategy has not fired yet", () => {
  render({
    scripts: [
      {
        name: "pixel",
        src: PIXEL_SRC,
        strategy: "interaction",
        category: "analytics",
      },
    ],
  });

  consent("analytics");
  expect(loaded(PIXEL_SRC)).toBe(0);

  press("#content");
  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a denied interaction script loads at the grant, and not before its interaction", () => {
  render({
    scripts: [
      {
        name: "pixel",
        src: PIXEL_SRC,
        strategy: "interaction",
        category: "analytics",
      },
    ],
  });

  press("#content");
  expect(loaded(PIXEL_SRC)).toBe(0);

  consent("analytics");
  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a categorized script is gated even where the site configured a worker runtime", async () => {
  const runtime = (): readonly string[] => [
    "<script>/* the mechanism this site supplies */</script>",
  ];
  render({
    scripts: [{ name: "pixel", src: PIXEL_SRC, category: "analytics" }],
    runtime,
  });

  await idle();
  expect(loaded(PIXEL_SRC)).toBe(0);

  consent("analytics");
  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a granted script waiting on its trigger is stopped by a revocation", () => {
  render({
    scripts: [
      {
        name: "pixel",
        src: PIXEL_SRC,
        strategy: "interaction",
        category: "analytics",
      },
    ],
  });

  consent("analytics");
  consent();

  press("#content");
  expect(loaded(PIXEL_SRC)).toBe(0);
});

test("a revocation after a grant does not stop the script already loading", async () => {
  render(PIXEL);
  await idle();
  consent("analytics");
  expect(loaded(PIXEL_SRC)).toBe(1);

  consent();

  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a second grant does not load the script twice", async () => {
  render(PIXEL);
  await idle();

  consent("analytics");
  consent("analytics");

  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a necessary script loads without waiting on consent", async () => {
  render({
    scripts: [
      {
        name: "consent",
        src: CONSENT_SRC,
        strategy: "idle",
        category: "necessary",
      },
    ],
  });

  await idle();

  expect(loaded(CONSENT_SRC)).toBe(1);
});

test("a script with no category loads exactly as it did before this feature", async () => {
  render({ scripts: [{ name: "pixel", src: PIXEL_SRC, strategy: "idle" }] });

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a market that grants a category by default loads without a source at all", async () => {
  const settings: ScriptsSetting = {
    ...PIXEL,
    consentDefaults: { "en:/**": { analytics: "granted" } },
  };

  render(settings, HOME);
  await idle();
  expect(loaded(PIXEL_SRC)).toBe(1);

  render(settings, DE_HOME);
  await idle();
  expect(loaded(PIXEL_SRC)).toBe(0);
});

test("an installed source overrides the market default in both directions", async () => {
  const settings: ScriptsSetting = {
    ...PIXEL,
    consentDefaults: { "en:/**": { analytics: "granted" } },
  };

  render(settings, HOME);
  consent();

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(0);
});

test("a categorized facade waits for a press made while consent stands", () => {
  render({
    scripts: [
      {
        name: "chat",
        src: CONSENT_SRC,
        strategy: "facade",
        category: "marketing",
        facade: { html: '<button id="chat">Chat</button>' },
      },
    ],
  });

  press("#chat");
  expect(loaded(CONSENT_SRC)).toBe(0);

  consent("marketing");
  expect(loaded(CONSENT_SRC)).toBe(0);

  press("#chat");
  expect(loaded(CONSENT_SRC)).toBe(1);
});

test("a functional facade is denied until a source grants functional, and then a press loads it", () => {
  render({
    scripts: [
      {
        name: "video",
        src: CONSENT_SRC,
        strategy: "facade",
        category: "functional",
        facade: { html: '<button id="video">Play</button>' },
      },
    ],
  });

  expect(facadeState()).toBe("denied");
  press("#video");
  expect(loaded(CONSENT_SRC)).toBe(0);

  consent("analytics", "marketing");
  press("#video");
  expect(loaded(CONSENT_SRC)).toBe(0);

  consent("functional");
  expect(facadeState()).toBe("granted");
  press("#video");
  expect(loaded(CONSENT_SRC)).toBe(1);
});

function facadeState(): string | null {
  const found = document.querySelector("[data-fw-facade]");
  if (found === null) throw new Error("the page carries no facade placeholder");
  return found.getAttribute(CONSENT_ATTRIBUTE);
}

const GATED_FACADE: ScriptsSetting = {
  scripts: [
    {
      name: "chat",
      src: CONSENT_SRC,
      strategy: "facade",
      category: "marketing",
      facade: { html: '<button id="chat">Chat</button>' },
    },
  ],
};

test("a refused press leaves a placeholder that says which state refused it", () => {
  render(GATED_FACADE);

  expect(facadeState()).toBe("denied");

  press("#chat");

  expect(loaded(CONSENT_SRC)).toBe(0);
  expect(facadeState()).toBe("denied");
});

test("a consent change moves the placeholder's state with no reload", () => {
  render(GATED_FACADE);
  expect(facadeState()).toBe("denied");

  consent("marketing");

  expect(facadeState()).toBe("granted");

  consent();
  expect(facadeState()).toBe("denied");
});

test("a granted state is not a promotion, and the press is still what loads", () => {
  render(GATED_FACADE);
  press("#chat");
  expect(loaded(CONSENT_SRC)).toBe(0);

  consent("marketing");

  expect(facadeState()).toBe("granted");
  expect(loaded(CONSENT_SRC)).toBe(0);

  press("#chat");
  expect(loaded(CONSENT_SRC)).toBe(1);
});

test("a source installed before the loader runs is what the placeholder's first state reads", () => {
  render(GATED_FACADE, HOME, [
    `window[${JSON.stringify(CONSENT_GLOBAL)}]={granted:function(){return true}}`,
  ]);

  expect(facadeState()).toBe("granted");
});

test("an uncategorized facade's placeholder carries no state at all", () => {
  render({
    scripts: [
      {
        name: "chat",
        src: CONSENT_SRC,
        strategy: "facade",
        facade: { html: '<button id="chat">Chat</button>' },
      },
    ],
  });

  expect(facadeState()).toBeNull();

  consent("marketing");
  expect(facadeState()).toBeNull();
});

const SITE_STORAGE_KEY = "site-consent";

// Written out rather than imported from the design system, which core must not import.
// Classic-script style: it runs unbundled in the head.
const PRE_PAINT = `(function(){try{var raw=localStorage.getItem(${JSON.stringify(
  SITE_STORAGE_KEY,
)});if(!raw)return;var held=JSON.parse(raw);if(typeof held.analytics!=="boolean")return;window[${JSON.stringify(
  CONSENT_GLOBAL,
)}]={granted:function(c){return c==="necessary"?true:held[c]===true}}}catch(e){}})()`;

function earlierVisit(decision?: { analytics: boolean; marketing: boolean }) {
  const key = JSON.stringify(SITE_STORAGE_KEY);
  return decision === undefined
    ? `localStorage.removeItem(${key})`
    : `localStorage.setItem(${key},${JSON.stringify(JSON.stringify(decision))})`;
}

const OPT_OUT: ScriptsSetting = {
  ...PIXEL,
  consentDefaults: { "en:/**": { analytics: "granted" } },
};

test("a returning visitor's stored rejection governs the first trigger, not the ones after hydration", async () => {
  render(OPT_OUT, HOME, [
    earlierVisit({ analytics: false, marketing: false }),
    PRE_PAINT,
  ]);

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(0);
});

test("a visitor who has not answered is still governed by the market default", async () => {
  render(OPT_OUT, HOME, [earlierVisit(), PRE_PAINT]);

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a returning visitor's stored acceptance loads a script an opt-in market would have held", async () => {
  render({ ...PIXEL }, HOME, [
    earlierVisit({ analytics: true, marketing: true }),
    PRE_PAINT,
  ]);

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(1);
});

test("a record this browser cannot read leaves the market default in charge", async () => {
  render(OPT_OUT, HOME, [
    `localStorage.setItem(${JSON.stringify(SITE_STORAGE_KEY)},"{oops")`,
    PRE_PAINT,
  ]);

  await idle();

  expect(loaded(PIXEL_SRC)).toBe(1);
});
