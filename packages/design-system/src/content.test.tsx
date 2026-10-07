import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Fragment, createElement } from "react";
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DRAFT_ENTRIES, PUBLISHED_ENTRIES } from "@pagedeck/site/content";
import { catalog } from "./catalog.js";
import { propsOf } from "./site.test-support.js";
import { SITE_IMAGES } from "@pagedeck/site/images";
import { safelist } from "./index.js";
import type { Block, PageEntry } from "@pagedeck/site/content";
import type { PropsContext } from "@pagedeck/site/props";
import type { ComponentType, ReactElement } from "react";

type AnyComponent = ComponentType<Record<string, unknown>>;

const resolve = createRequire(import.meta.url).resolve;

const loaded = new Map<string, AnyComponent>();

const rendered = new Map<string, { markup?: string; fault?: string }>();

const exercised = new Set<string>();

function componentFor(name: string): AnyComponent {
  const component = loaded.get(name);
  if (component === undefined) {
    throw new Error(`no component is registered under "${name}"`);
  }
  exercised.add(name);
  return component;
}

// `aboveFold: false` is not a fold claim: only a whole-page render can number
// nodes, and this file asserts on neither answer.
function contextFor(entry: PageEntry): PropsContext {
  return {
    images: SITE_IMAGES,
    page: { locale: entry.locale, path: `/${entry.path}` },
    aboveFold: false,
  };
}

function element(node: Block, context: PropsContext): ReactElement {
  return createElement(
    componentFor(node.component),
    { ...propsOf(node, context), key: node.id },
    ...node.children.map((child) => element(child, context)),
  );
}

function markupOf(entry: PageEntry): string {
  if (entry.data.mode === "tree") {
    return renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        ...entry.data.tree.map((node) => element(node, contextFor(entry))),
      ),
    );
  }
  return renderToStaticMarkup(
    createElement(componentFor(entry.data.template), { ...entry.data }),
  );
}

function keyOf(version: string, entry: PageEntry): string {
  return `${version}/${entry.locale}/${entry.path}`;
}

beforeAll(async () => {
  for (const [name, entry] of Object.entries(catalog)) {
    const module = (await entry.import()) as { default: AnyComponent };
    loaded.set(name, module.default);
  }
  for (const [version, entries] of [
    ["published", PUBLISHED_ENTRIES],
    ["draft", DRAFT_ENTRIES],
  ] as const) {
    for (const entry of entries) {
      try {
        rendered.set(keyOf(version, entry), { markup: markupOf(entry) });
      } catch (error) {
        rendered.set(keyOf(version, entry), {
          fault: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
});

function markup(key: string): string {
  const result = rendered.get(key);
  if (result?.markup === undefined) {
    throw new Error(
      `/${key} did not render: ${result?.fault ?? "not rendered"}`,
    );
  }
  return result.markup;
}

test("every entry renders", () => {
  const faults: string[] = [];
  for (const [key, result] of [...rendered].sort()) {
    if (result.fault !== undefined) faults.push(`  /${key}: ${result.fault}`);
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

const UNNAMED_BY_CONTENT: readonly string[] = ["consent_banner"];

test("the entries exercise every registered component they can name", () => {
  expect([...exercised].sort()).toEqual(
    Object.keys(catalog)
      .filter((name) => !UNNAMED_BY_CONTENT.includes(name))
      .sort(),
  );
});

test("the call to action carries the link the entry put on it", () => {
  const html = markup("published/en/home");
  expect(html).toContain('href="/en/pricing"');
  expect(html).toContain(">See pricing</a>");
});

test("a call to action the site never resolved refuses to render", () => {
  const home = PUBLISHED_ENTRIES.find((entry) => entry.path === "home")?.data;
  const cta = home?.mode === "tree" ? home.tree[0]?.children[0] : undefined;
  expect(cta?.component).toBe("button");
  expect(cta?.props).toHaveProperty("link");
  expect(() =>
    renderToStaticMarkup(
      createElement(componentFor("button"), { ...cta?.props }),
    ),
  ).toThrow(/See pricing[\s\S]*href/);
});

test("the legal page renders the entry's title and its body", () => {
  const html = markup("published/en/legal/terms");
  expect(html).toContain("<h1>Terms</h1>");
  expect(html).toContain("<p>The terms.</p>");
});

test("the pricing template renders the plans the entry holds", () => {
  const html = markup("published/en/pricing");
  expect(html).toContain("<h1>Plans</h1>");
  expect(html).toContain("<td>Starter</td>");
  expect(html).toContain("<td>49</td>");
});

test("the draft-only landing template renders its headline", () => {
  expect(markup("draft/en/careers")).toContain("<h1>Join us</h1>");
});

test("a draft landing entry with no email label refuses to render", () => {
  const careers = DRAFT_ENTRIES.find(
    (entry) => entry.path === "careers",
  );
  const data = careers?.data;
  if (careers === undefined || data?.mode !== "template") {
    throw new Error("the draft entries hold no en/careers template entry");
  }
  const { email_label: removed, ...fields } = data.fields;
  expect(removed).toBe("Email address");
  const unlabelled: PageEntry = {
    ...careers,
    data: { ...data, fields },
  };
  expect(() => markupOf(unlabelled)).toThrow(
    /^LandingPage "Join us": 1 copy field is missing[\s\S]*email_label/,
  );
});

function headingLevels(html: string): readonly number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) =>
    Number(match[1]),
  );
}

test("no entry skips a heading level", () => {
  const skips: string[] = [];
  for (const [key, result] of [...rendered].sort()) {
    if (result.markup === undefined) continue;
    const levels = headingLevels(result.markup);
    levels.reduce((previous, level) => {
      if (level > previous + 1) {
        skips.push(`  /${key}: h${String(previous)} then h${String(level)}`);
      }
      return level;
    }, levels[0] ?? 1);
  }
  expect(skips.length === 0 ? "" : `\n${skips.join("\n")}`).toBe("");
});

test("every field the entries set reaches the component that renders it", () => {
  // Comments are stripped first, so a field named in a docblock does not count as
  // read. Tree nodes only: a template's `fields` are its collection's schema.
  const code = new Map(
    Object.entries(catalog).map(([name, entry]) => [
      name,
      readFileSync(resolve(entry.module), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, ""),
    ]),
  );
  const faults: string[] = [];
  const walk = (
    nodes: readonly Block[],
    at: string,
    context: PropsContext,
  ): void => {
    for (const node of nodes) {
      for (const field of Object.keys(propsOf(node, context))) {
        if (code.get(node.component)?.includes(field) === true) continue;
        faults.push(`  ${at} ${node.component}: "${field}" is read by nothing`);
      }
      walk(node.children, at, context);
    }
  };
  for (const [version, entries] of [
    ["published", PUBLISHED_ENTRIES],
    ["draft", DRAFT_ENTRIES],
  ] as const) {
    for (const entry of entries) {
      if (entry.data.mode === "tree") {
        walk(entry.data.tree, `/${keyOf(version, entry)}:`, contextFor(entry));
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("every class the entries render is one the safelist declares", () => {
  const listed = new Set(Object.values(safelist).flat());
  const faults: string[] = [];
  for (const [key, result] of [...rendered].sort()) {
    for (const [, attribute] of (result.markup ?? "").matchAll(
      /class="([^"]*)"/g,
    )) {
      for (const one of (attribute ?? "").split(" ")) {
        if (one === "" || listed.has(one)) continue;
        faults.push(`  /${key}: "${one}" is in no safelist`);
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});
