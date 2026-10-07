// @vitest-environment jsdom
import { act, createElement, useId, useState } from "react";
import type { ComponentType, ReactElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { hotIslands } from "./hmr.js";
import type { IslandModules } from "./hmr.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  appendChild(child: TestElement): void;
  querySelector(selector: string): TestElement | null;
  click(): void;
}
declare const document: {
  body: TestElement;
  createElement(tag: string): TestElement;
};

// Hoisted: React reads `reportError` once, when `react-dom/client` first loads,
// and this file loads it at import time.
const reported: string[] = vi.hoisted(() => {
  const lines: string[] = [];
  (globalThis as { reportError?: (error: unknown) => void }).reportError = (
    error,
  ) => {
    lines.push(String(error));
  };
  return lines;
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reported.length = 0;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
});

function counter(edit: string): ComponentType<never> {
  return function Counter() {
    const [clicks, setClicks] = useState(0);
    return createElement(
      "button",
      {
        onClick: () => {
          setClicks(clicks + 1);
        },
      },
      `${edit}:${String(clicks)}`,
    );
  };
}

function modulesOf(
  components: Readonly<Record<string, ComponentType<never>>>,
): IslandModules {
  return Object.fromEntries(
    Object.entries(components).map(([name, component]) => [
      name,
      () => Promise.resolve({ default: component }),
    ]),
  );
}

async function mount(component: ComponentType<never>): Promise<TestElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(createElement(component));
  });
  return container;
}

async function click(container: TestElement): Promise<void> {
  await act(async () => {
    container.querySelector("button")?.click();
  });
}

test("an update swaps the edited island and costs only that island's state", async () => {
  const hot = { data: {} };
  // Held here: an entry's thunks answer with the module, never with a wrapper
  // `resolve` made.
  const sidebar = counter("sidebar");

  const first = hotIslands(
    hot,
    modulesOf({ counter: counter("before"), sidebar }),
  );
  expect(first.hydrated).toBe(false);

  const counterIsland = await mount(await first.resolve("counter"));
  const sidebarIsland = await mount(await first.resolve("sidebar"));
  await click(counterIsland);
  await click(sidebarIsland);
  await click(sidebarIsland);
  expect(counterIsland.textContent).toBe("before:1");
  expect(sidebarIsland.textContent).toBe("sidebar:2");

  const second = hotIslands(
    hot,
    modulesOf({ counter: counter("after"), sidebar }),
  );
  expect(second.hydrated).toBe(true);
  await act(async () => {
    await Promise.resolve();
  });

  expect(counterIsland.textContent).toBe("after:0");
  expect(sidebarIsland.textContent).toBe("sidebar:2");
});

test("the swap wrapper leaves the ids React generates unchanged", async () => {
  function Labelled(): ReactElement {
    return createElement("p", { id: useId() }, "labelled");
  }

  const { prelude } = await prerender(createElement(Labelled), {
    identifierPrefix: "p0",
  });
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of prelude) html += decoder.decode(chunk, { stream: true });
  html += decoder.decode();

  const container = document.createElement("div");
  document.body.appendChild(container);
  container.innerHTML = html;

  const hot = { data: {} };
  const hydrate = hotIslands(hot, modulesOf({ labelled: Labelled }));
  const component = await hydrate.resolve("labelled");
  await act(async () => {
    hydrateRoot(container, createElement(component), {
      identifierPrefix: "p0",
    });
  });

  expect(reported).toEqual([]);
  expect(container.innerHTML).toBe(html);
});
