import { expect, test } from "vitest";
import {
  VIEW_TRANSITION_STYLE,
  viewTransitionsFaultReport,
} from "./view-transitions.js";

const WHERE = 'Config "/site/pagedeck.config.ts"';

test("the emitted element is the cross-document at-rule and nothing else", () => {
  expect(VIEW_TRANSITION_STYLE).toBe(
    "<style>@view-transition { navigation: auto; }</style>",
  );
});

test("a value that is not a boolean is refused, with the fix", () => {
  expect(viewTransitionsFaultReport("auto", WHERE)).toBe(
    `${WHERE}: "build.viewTransitions" must be true or false — viewTransitions: true`,
  );
  expect(viewTransitionsFaultReport(1, WHERE)).toBe(
    `${WHERE}: "build.viewTransitions" must be true or false — viewTransitions: true`,
  );
});

test("both booleans are settings, and neither is a fault", () => {
  expect(viewTransitionsFaultReport(true, WHERE)).toBe(undefined);
  expect(viewTransitionsFaultReport(false, WHERE)).toBe(undefined);
});
