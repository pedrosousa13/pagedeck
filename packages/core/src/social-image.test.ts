import { expect, test } from "vitest";
import { socialImagesFaultReport } from "./social-image.js";

const WHERE = 'Config "/site/pagedeck.config.ts"';

const WELL_FORMED = {
  adapter: { name: "acme-cards", draw: () => ({ bytes: new Uint8Array(), width: 1, height: 1 }) },
  inputs: () => ({ title: "Pricing" }),
};

test("a well-formed declaration has nothing to report", () => {
  expect(socialImagesFaultReport(WELL_FORMED, WHERE)).toBeUndefined();
});

test("a section that is not an object is refused with the shape it should have", () => {
  const report = socialImagesFaultReport([], WHERE);

  expect(report).toContain('"build.socialImages" must be an object');
  expect(report).toContain("adapter:");
  expect(report).toContain("inputs:");
});

test("an adapter missing its name and its draw function is refused one line per field", () => {
  const report = socialImagesFaultReport({ ...WELL_FORMED, adapter: {} }, WHERE);

  expect(report).toContain('"build.socialImages.adapter" declares 2 fields');
  expect(report).toContain('"adapter.name"');
  expect(report).toContain('"adapter.draw"');
});

test("an adapter whose name is blank is not a name", () => {
  const report = socialImagesFaultReport(
    { ...WELL_FORMED, adapter: { ...WELL_FORMED.adapter, name: "  " } },
    WHERE,
  );

  expect(report).toContain('"adapter.name"');
  expect(report).not.toContain('"adapter.draw"');
});

test("an inputs field that is not a function is refused", () => {
  const report = socialImagesFaultReport(
    { ...WELL_FORMED, inputs: { title: "Pricing" } },
    WHERE,
  );

  expect(report).toContain('"build.socialImages.inputs"');
  expect(report).toContain("not a function");
});

test("a fault in the adapter and a fault in inputs are reported in one run", () => {
  const report = socialImagesFaultReport({ adapter: {}, inputs: 3 }, WHERE);

  expect(report).toContain('"adapter.name"');
  expect(report).toContain('"build.socialImages.inputs"');
});
