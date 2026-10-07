// A regular-expression scan of each catalog file's `className`s, so a spread, a
// class added after render and a class from an imported helper go unseen.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Button from "./components/button.js";
import FeatureGrid from "./components/feature_grid.js";
import Hero from "./components/hero.js";
import { catalog } from "./catalog.js";
import { COMPONENT_CLASSES } from "./component-classes.js";
import { safelist } from "./index.js";
import { STYLING_OPTIONS } from "./styling.js";
import type { ReactElement } from "react";

// `src`, not `resolve(entry.module)`: that lands in `dist`, where JSX has
// compiled `className=` away and every pattern here matches nothing.
function sourceOf(name: string): string {
  return readFileSync(
    new URL(`./components/${name}.tsx`, import.meta.url),
    "utf8",
  );
}

const CLASS_NAME = String.raw`className\s*=\s*`;

const QUOTED = new RegExp(`${CLASS_NAME}"([^"]*)"`, "g");

const TEMPLATED = new RegExp(`${CLASS_NAME}\\{\\s*\`([^\`]*)\`\\s*\\}`, "g");

const ANY_CLASS_NAME = new RegExp(CLASS_NAME, "g");

const SUBSTITUTION = /\$\{([^}]*)\}/g;

// Anchored at both ends, or `classesFor(a) + title` passes; `[^()]*`, because a
// greedy `.*` spans `classesFor(a) + classesFor(b)`.
const WHOLE_CALL = /^classesFor\([^()]*\)$/;

// Not global: it is read with `test`, and a global regex carries `lastIndex`.
const RAW_HTML = /dangerouslySetInnerHTML/;

function classesStatedIn(source: string): Set<string> {
  const found = new Set<string>();
  const add = (written: string): void => {
    for (const one of written.split(/\s+/)) if (one !== "") found.add(one);
  };
  for (const [, literal] of source.matchAll(QUOTED)) {
    add(literal ?? "");
  }
  for (const [, template] of source.matchAll(TEMPLATED)) {
    add((template ?? "").replace(SUBSTITUTION, " "));
  }
  return found;
}

function spellingFaults(source: string): string[] {
  const faults: string[] = [];
  const templates = [...source.matchAll(TEMPLATED)];
  for (const [, template] of templates) {
    for (const [, expression] of (template ?? "").matchAll(SUBSTITUTION)) {
      if (WHOLE_CALL.test((expression ?? "").trim())) continue;
      faults.push(`className interpolates ${expression ?? ""}`);
    }
  }
  const written = [...source.matchAll(ANY_CLASS_NAME)].length;
  const quoted = [...source.matchAll(QUOTED)].length;
  if (written !== quoted + templates.length) {
    faults.push(
      `a className is spelled neither "…" nor {\`…\`}, so what it holds is unread here`,
    );
  }
  if (RAW_HTML.test(source)) {
    faults.push(
      "writes raw HTML, where a class is a class= attribute inside a string and nothing here reads one",
    );
  }
  return faults;
}

const RENDERS: readonly {
  field: string;
  component: string;
  render: (value: string) => ReactElement;
}[] = [
  {
    field: "hero.theme",
    component: "hero",
    render: (theme) => <Hero headline="Ship the site" theme={theme} />,
  },
  {
    field: "button.variant",
    component: "button",
    render: (variant) => (
      <Button href="/en/pricing" label="See pricing" variant={variant} />
    ),
  },
  {
    field: "feature_grid.columns",
    component: "feature_grid",
    render: (columns) => <FeatureGrid columns={columns} />,
  },
];

function classesIn(html: string): Set<string> {
  const found = new Set<string>();
  for (const [, attribute] of html.matchAll(/class="([^"]*)"/g)) {
    for (const one of (attribute ?? "").split(" ")) {
      if (one !== "") found.add(one);
    }
  }
  return found;
}

test("the safelist holds every class the styling options can render", () => {
  const faults: string[] = [];
  for (const [field, option] of Object.entries(STYLING_OPTIONS)) {
    const declared = Object.values(option.values).flatMap((all) =>
      all.split(" "),
    );
    const listed = new Set(safelist[field] ?? []);
    for (const one of declared) {
      if (!listed.has(one)) faults.push(`  ${field}: ${one}`);
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("the safelist is keyed by where each class came from, sorted and deduped", () => {
  expect(Object.keys(safelist).sort()).toEqual(
    [...Object.keys(STYLING_OPTIONS), ...Object.keys(COMPONENT_CLASSES)].sort(),
  );
  for (const field of Object.keys(STYLING_OPTIONS)) {
    expect(Object.hasOwn(COMPONENT_CLASSES, field), field).toBe(false);
  }
  for (const [field, classes] of Object.entries(safelist)) {
    expect([...classes], field).toEqual([...new Set(classes)].sort());
  }
});

test("every styling option is one a catalog component renders", () => {
  expect(RENDERS.map((one) => one.field).sort()).toEqual(
    Object.keys(STYLING_OPTIONS).sort(),
  );
  const faults = Object.keys(STYLING_OPTIONS)
    .filter((field) => !Object.hasOwn(catalog, field.split(".")[0] ?? field))
    .map((field) => `  ${field}: names no component in the catalog`);
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("no component builds a class out of anything but classesFor", () => {
  const faults: string[] = [];
  for (const name of Object.keys(catalog)) {
    for (const fault of spellingFaults(sourceOf(name))) {
      faults.push(`  ${name}: ${fault}`);
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("a className spelled with spaces around its = states its classes", () => {
  expect([...classesStatedIn(`<span className = "rogue" />`)]).toEqual([
    "rogue",
  ]);
});

test("a className spelled with spaces around its = is counted", () => {
  expect(spellingFaults(`<span className = {cx("rogue")} />`)).toEqual([
    `a className is spelled neither "…" nor {\`…\`}, so what it holds is unread here`,
  ]);
});

test("a substitution that concatenates onto a classesFor call is refused", () => {
  expect(
    spellingFaults(
      "<article className={`card ${classesFor(\"hero.theme\", undefined) + \" \" + title}`}>",
    ),
  ).toEqual([
    `className interpolates classesFor("hero.theme", undefined) + " " + title`,
  ]);
});

test("a component that writes raw HTML is refused", () => {
  expect(
    spellingFaults(
      `<div dangerouslySetInnerHTML={{ __html: '<b class="rogue">!</b>' }} />`,
    ),
  ).toEqual([
    "writes raw HTML, where a class is a class= attribute inside a string and nothing here reads one",
  ]);
});

test("every class a styled component renders comes from the safelist", () => {
  const faults: string[] = [];
  for (const { field, component, render } of RENDERS) {
    const option = STYLING_OPTIONS[field];
    if (option === undefined) throw new Error(`no styling field "${field}"`);
    const base = COMPONENT_CLASSES[component] ?? [];
    const listed = new Set(safelist[field] ?? []);
    for (const [value, expected] of Object.entries(option.values)) {
      const rendered = classesIn(renderToStaticMarkup(render(value)));
      for (const one of expected.split(" ")) {
        if (!rendered.has(one)) {
          faults.push(`  ${field}="${value}": did not render ${one}`);
        }
      }
      for (const one of rendered) {
        if (!listed.has(one) && !base.includes(one)) {
          faults.push(
            `  ${field}="${value}": rendered ${one}, which is in no safelist and is not the component's own class`,
          );
        }
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("the safelist holds every class a component's source states, and no other", () => {
  const listed = new Set(Object.values(safelist).flat());
  const faults: string[] = [];
  for (const name of Object.keys(catalog)) {
    const written = classesStatedIn(sourceOf(name));
    for (const one of written) {
      if (!listed.has(one)) {
        faults.push(`  ${name}: states "${one}", which is in no safelist`);
      }
    }
    for (const one of safelist[name] ?? []) {
      if (!written.has(one)) {
        faults.push(
          `  ${name}: declares "${one}", which its source never states`,
        );
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});

test("a value the CMS never offered fails rather than falling back", () => {
  expect(() =>
    renderToStaticMarkup(<Hero headline="x" theme="neon" />),
  ).toThrow(/"neon" is not one of the values it offers/);
});
