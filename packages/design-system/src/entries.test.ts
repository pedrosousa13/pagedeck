import { expect, test } from "vitest";
import { catalog } from "./catalog.js";
import { planEntries } from "@pagedeck/core";
import type { Page } from "@pagedeck/core";

const MODULES = Object.fromEntries(
  Object.entries(catalog).map(([name, entry]) => [name, entry.module]),
);

function page(locale: string, path: `/${string}`): Page {
  return { locale, path, output: `/${locale}${path}`, dependencies: [] };
}

const PLAN = planEntries(
  [
    { page: page("en", "/legal/terms"), islands: [] },
    {
      page: page("en", "/pricing"),
      islands: [{ component: "pricing_page", mode: "visible" }],
    },
  ],
  { modules: MODULES },
);

test("a page with no island gets no entry module", () => {
  expect(PLAN.contentOnly).toEqual([{ locale: "en", path: "/legal/terms" }]);
});

test("an islanded page's entry imports the package's own subpath", () => {
  expect(PLAN.entries).toHaveLength(1);
  expect(PLAN.entries[0]?.components).toEqual([
    {
      name: "pricing_page",
      module: catalog.pricing_page.module,
      eager: false,
    },
  ]);
});

test("a component with no row fails the plan before the bundler runs", () => {
  expect(() =>
    planEntries(
      [
        {
          page: page("en", "/home"),
          islands: [{ component: "unregistered_widget", mode: "load" }],
        },
      ],
      { modules: MODULES },
    ),
  ).toThrow(/unregistered_widget/);
});
