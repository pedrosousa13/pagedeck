// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest";
import {
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_TAG,
} from "@pagedeck/islands";
import type { ComponentRegistry } from "@pagedeck/islands";
import { renderPage } from "./render.js";

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface TestElement {
  innerHTML: string;
  tagName: string;
  getAttribute(name: string): string | null;
  attributes: ArrayLike<{ name: string }>;
  focus(): void;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): readonly TestElement[];
  closest(selector: string): TestElement | null;
  content?: { querySelector(selector: string): TestElement | null };
}
declare const document: {
  createElement(tag: "div"): TestElement;
  body: { innerHTML: string; appendChild(node: TestElement): void };
  activeElement: TestElement | null;
};

function parse(html: string): TestElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

const PAGE = { locale: "en", path: "/home" } as const;

const HOSTILE_PROPS = {
  breakout: '</script><script>alert("xss")</script>',
  quotes: `he said "hi" and 'bye'`,
  angles: "<b> & </b> <!-- -->",
  spaced: "two words",
  nested: { "</script>": ["<img src=x onerror=alert(1)>", "a b"] },
} as const;

function Echo(props: Record<string, unknown>) {
  return <span>{JSON.stringify(props).length}</span>;
}

const REGISTRY = {
  Echo: { import: async () => ({ default: Echo }) },
} satisfies ComponentRegistry;
const ECHO_IS_CLIENT = { Echo: { useClient: true } };

test("a prop payload of quote- and script-breaking content round-trips equal", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Echo", props: HOSTILE_PROPS }],
    registry: REGISTRY,
    modules: ECHO_IS_CLIENT,
  });

  const marker = parse(html).querySelector(ISLAND_TAG);
  const payload = marker?.getAttribute(ISLAND_PROPS_ATTRIBUTE);

  expect(JSON.parse(payload ?? "null")).toEqual(HOSTILE_PROPS);
});

test("a prop payload of script-breaking content creates no element of its own", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Echo", props: HOSTILE_PROPS }],
    registry: REGISTRY,
    modules: ECHO_IS_CLIENT,
  });

  const page = parse(html);

  expect(page.querySelectorAll("script")).toHaveLength(0);
  expect(page.querySelectorAll("img")).toHaveLength(0);
});

test("the parser moves a marker out of table markup, which is why the build refuses it", async () => {
  // Literal HTML: `renderPage` refuses to produce it, and this is the premise of that
  // refusal.
  const page = parse(
    `<table><tbody><tr><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}><td>cell</td></tr></tbody></table>`,
  );

  const marker = page.querySelector(ISLAND_TAG);

  expect(marker).not.toBeNull();
  expect(marker?.closest("table")).toBeNull();
});

test("a wrapper element does not keep the marker in the table", async () => {
  const shapes = [
    `<table><form><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></form></table>`,
    `<table><tbody><tr><div><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></div></tr></tbody></table>`,
  ];

  for (const shape of shapes) {
    const marker = parse(shape).querySelector(ISLAND_TAG);

    expect(marker).not.toBeNull();
    expect(marker?.closest("table")).toBeNull();
  }
});

test("a cell keeps a marker under a wrapper, and inside a table of its own", async () => {
  const shapes = [
    `<table><tbody><tr><td><div><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></div></td></tr></tbody></table>`,
    `<table><tbody><tr><td><table><tbody><tr><td><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></td></tr></tbody></table></td></tr></tbody></table>`,
  ];

  for (const shape of shapes) {
    const marker = parse(shape).querySelector(ISLAND_TAG);

    expect(marker?.closest("table")).not.toBeNull();
    expect(marker?.closest("td")).not.toBeNull();
  }
});

test("the parser destroys a marker inside a select, which is why the build refuses it", async () => {
  const shapes = [
    `<select><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></select>`,
    `<select><option>a</option><div><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></div></select>`,
  ];

  for (const shape of shapes) {
    expect(parse(shape).querySelector(ISLAND_TAG)).toBeNull();
  }
});

test("the parser puts a marker inside a template in a fragment of its own", async () => {
  const page = parse(
    `<template><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></template>`,
  );

  expect(page.querySelector(ISLAND_TAG)).toBeNull();
  expect(
    page.querySelector("template")?.content?.querySelector(ISLAND_TAG),
  ).not.toBeNull();
});

test("a table inside a template strands the marker in the template, not the table", async () => {
  const page = parse(
    `<template><table><tbody><tr><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></tr></tbody></table></template>`,
  );

  expect(page.querySelector(ISLAND_TAG)).toBeNull();
  const stranded = page.querySelector("template")?.content?.querySelector(ISLAND_TAG);
  expect(stranded).not.toBeNull();
  expect(stranded?.closest("table")).toBeNull();
});

test("a template inside a row keeps its place, and the marker with it", async () => {
  const page = parse(
    `<table><tbody><tr><template><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></template></tr></tbody></table>`,
  );

  expect(page.querySelector(ISLAND_TAG)).toBeNull();
  const template = page.querySelector("template");
  expect(template?.closest("tr")).not.toBeNull();
  expect(template?.content?.querySelector(ISLAND_TAG)).not.toBeNull();
});

test("between a select and a template, the inner one is what acts", async () => {
  const templateInSelect = parse(
    `<select><template><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></template></select>`,
  );

  expect(templateInSelect.querySelector(ISLAND_TAG)).toBeNull();
  expect(
    templateInSelect.querySelector("template")?.content?.querySelector(ISLAND_TAG),
  ).not.toBeNull();

  const selectInTemplate = parse(
    `<template><select><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}></select></template>`,
  );

  expect(selectInTemplate.querySelector(ISLAND_TAG)).toBeNull();
  expect(
    selectInTemplate.querySelector("template")?.content?.querySelector(ISLAND_TAG),
  ).toBeNull();
});

test("the parser moves a marker out of a colgroup too, which is why the build refuses that", async () => {
  const page = parse(
    `<table><colgroup><${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="i0" role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}><col/></colgroup><tbody><tr><td>cell</td></tr></tbody></table>`,
  );

  const marker = page.querySelector(ISLAND_TAG);

  expect(marker).not.toBeNull();
  expect(marker?.closest("table")).toBeNull();
});

// WAI-ARIA 1.2 §6.5 entire, plus the three ARIA 1.3 adds. Not an `aria-*` prefix: a
// non-global attribute keeps the role (ARIA's Example 13).
const GLOBAL_ARIA_ATTRIBUTES: readonly string[] = [
  "aria-atomic",
  "aria-busy",
  "aria-controls",
  "aria-current",
  "aria-describedby",
  "aria-details",
  "aria-disabled",
  "aria-dropeffect",
  "aria-errormessage",
  "aria-flowto",
  "aria-grabbed",
  "aria-haspopup",
  "aria-hidden",
  "aria-invalid",
  "aria-keyshortcuts",
  "aria-label",
  "aria-labelledby",
  "aria-live",
  "aria-owns",
  "aria-relevant",
  "aria-roledescription",
  "aria-braillelabel",
  "aria-brailleroledescription",
  "aria-description",
];

beforeEach(() => {
  document.body.innerHTML = "";
});

// Connected: jsdom refuses focus to a disconnected element, which would pass for the
// wrong reason.
async function renderMarkerIntoDocument(): Promise<TestElement> {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Echo", props: { count: 1 } }],
    registry: REGISTRY,
    modules: ECHO_IS_CLIENT,
  });

  const host = parse(html);
  document.body.appendChild(host);
  const marker = host.querySelector(ISLAND_TAG);
  if (marker === null) {
    throw new Error("renderPage emitted no island marker to check");
  }
  return marker;
}

test("the emitted marker is not focusable, which its presentation role requires", async () => {
  const marker = await renderMarkerIntoDocument();

  expect(marker.getAttribute("tabindex")).toBeNull();
  expect(marker.getAttribute("contenteditable")).toBeNull();

  marker.focus();
  expect(document.activeElement).not.toBe(marker);
});

test("the emitted marker carries no global ARIA attribute, which its presentation role requires", async () => {
  const marker = await renderMarkerIntoDocument();

  const emitted = Array.from(marker.attributes).map((attribute) => attribute.name);

  expect(emitted.filter((name) => GLOBAL_ARIA_ATTRIBUTES.includes(name))).toEqual([]);
});
