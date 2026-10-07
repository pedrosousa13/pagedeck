import { expect, test } from "vitest";
import { planEntries } from "./entries.js";
import { entryInputs } from "./entry-modules.js";
import { renderPage } from "./render.js";
import type { Page } from "./pages.js";
import type { ComponentRegistry } from "@pagedeck/islands";

function Counter({ label }: { label: string }) {
  return <button type="button">{label}</button>;
}

function Prose({ text }: { text: string }) {
  return <p>{text}</p>;
}

const REGISTRY = {
  Counter: { import: async () => ({ default: Counter }), hydrate: "visible" },
  Prose: { import: async () => ({ default: Prose }) },
} satisfies ComponentRegistry;

const MODULES = { Counter: "@ds/counter", Prose: "@ds/prose" };

function page(locale: string, path: `/${string}`, output: string): Page {
  return { locale, path, output, dependencies: [] };
}

test("a render's islands are the demand's islands, unmapped", async () => {
  const row = page("en", "/signup", "/en/signup");
  const rendered = await renderPage({
    page: { locale: row.locale, path: row.path },
    tree: [
      { component: "Prose", props: { text: "Join us" } },
      { component: "Counter", props: { label: "One more" } },
    ],
    registry: REGISTRY,
  });

  // No mapping between the two: this pins `RenderedPage.islands` as assignable to
  // `planEntries`' input at compile time.
  const plan = planEntries([{ page: row, islands: rendered.islands }], {
    modules: MODULES,
  });

  expect(rendered.islands.map((island) => island.component)).toEqual([
    "Counter",
  ]);
  expect(plan.entries).toEqual([
    {
      locale: "en",
      path: "/signup",
      id: expect.stringMatching(/^\0fw:entry\/entry-[0-9a-f]{16}$/),
      name: expect.stringMatching(/^entry-[0-9a-f]{16}$/),
      components: [{ name: "Counter", module: "@ds/counter", eager: false }],
    },
  ]);
});

test("a content-only page's render yields no entry and no script", async () => {
  const row = page("en", "/about", "/en/about");
  const rendered = await renderPage({
    page: { locale: row.locale, path: row.path },
    tree: [{ component: "Prose", props: { text: "We make things" } }],
    registry: REGISTRY,
  });

  const plan = planEntries([{ page: row, islands: rendered.islands }], {
    modules: MODULES,
  });

  expect(plan.entries).toEqual([]);
  expect(plan.contentOnly).toEqual([{ locale: "en", path: "/about" }]);
  // `<script` unclosed on purpose, so an attribute or a type does not let a tag through.
  expect(entryInputs(plan)).toEqual({});
  expect(rendered.html).not.toContain("<script");
});

test("a page with an island still ships no script of its own yet", async () => {
  const rendered = await renderPage({
    page: { locale: "en", path: "/signup" },
    tree: [{ component: "Counter", props: { label: "One more" } }],
    registry: REGISTRY,
  });

  expect(rendered.islands).toHaveLength(1);
  expect(rendered.html).not.toContain("<script");
});
