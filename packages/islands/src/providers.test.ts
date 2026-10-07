import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { wrapInProviders } from "./providers.js";
import type { RootProvider } from "./providers.js";

function Frame({ tone, children }: { tone: string; children?: ReactNode }) {
  return createElement("div", { className: `frame frame--${tone}` }, children);
}

function Inner({ children }: { children?: ReactNode }) {
  return createElement("section", null, children);
}

const tree = createElement("p", null, "island");

const asStack = (value: readonly unknown[]): readonly RootProvider[] =>
  value as readonly RootProvider[];

const markup = (wrapped: ReactNode): string =>
  renderToStaticMarkup(wrapped as ReactElement);

test("a well-formed stack wraps the tree, providers[0] outermost", () => {
  expect(
    markup(
      wrapInProviders(
        tree,
        asStack([
          { component: Frame, props: { tone: "dark" } },
          { component: Inner },
        ]),
      ),
    ),
  ).toBe('<div class="frame frame--dark"><section><p>island</p></section></div>');
});

test("a stack whose entry has no component is applied as no stack at all", () => {
  expect(markup(wrapInProviders(tree, asStack([{ component: undefined }])))).toBe(
    "<p>island</p>",
  );
});

test("one malformed entry voids the whole stack, not only itself", () => {
  expect(
    markup(
      wrapInProviders(
        tree,
        asStack([{ component: Frame, props: { tone: "dark" } }, null]),
      ),
    ),
  ).toBe("<p>island</p>");
});

test("a stack that is not an array at all wraps nothing and does not throw", () => {
  expect(markup(wrapInProviders(tree, asStack({} as never)))).toBe(
    "<p>island</p>",
  );
});
