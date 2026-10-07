import { expect, test } from "vitest";
import {
  adapterEdgeArtifacts,
  adapterFaultReport,
  adapterTreeFiles,
} from "./build-adapter.js";

test("a build.adapter that is not an object is refused, naming the shape it takes", () => {
  expect(adapterFaultReport("netlify", "Config")).toBe(
    'Config: "build.adapter" must be an object with a name and a compile function — adapter: { name: "netlify", compile: (routing) => ({ artifacts: [] }) }, or an adapter package\'s factory, as adapter: netlify()',
  );
});

test("a build.adapter missing a name and a compile function reports both in one run", () => {
  const report = adapterFaultReport({}, "Config");
  expect(report).toContain('"build.adapter" declares 2 fields');
  expect(report).toContain('"name" — undefined — not an adapter name');
  expect(report).toContain('"compile" — undefined — not a compile function');
});

test("a build.adapter with a blank name and a working compile reports the name alone", () => {
  const report = adapterFaultReport(
    { name: "  ", compile: () => ({ artifacts: [] }) },
    "Config",
  );
  expect(report).toContain('"build.adapter" declares 1 field');
  expect(report).toContain('"name" — "  " — not an adapter name');
});

test("a build.adapter with a name and a compile function is accepted", () => {
  expect(
    adapterFaultReport({ name: "netlify", compile: () => ({ artifacts: [] }) }, "Config"),
  ).toBeUndefined();
});

test("adapterTreeFiles keeps only the tree-file role, as asset EmittedFiles", () => {
  const files = adapterTreeFiles({
    artifacts: [
      { role: "tree-file", path: "/_redirects", contents: "a\n" },
      { role: "function", path: "worker.js", contents: "b\n" },
      { domain: "shop.example", role: "tree-file", path: "/_redirects", contents: "c\n" },
    ],
  });
  expect(files).toEqual([
    { path: "/_redirects", kind: "asset", contents: "a\n" },
    { domain: "shop.example", path: "/_redirects", kind: "asset", contents: "c\n" },
  ]);
});

test("adapterEdgeArtifacts keeps every role but tree-file", () => {
  const artifacts = adapterEdgeArtifacts({
    artifacts: [
      { role: "tree-file", path: "/_redirects", contents: "a\n" },
      { role: "function", path: "worker.js", contents: "b\n" },
      { role: "dataset", path: "redirects.json", contents: "{}" },
    ],
  });
  expect(artifacts.map((artifact) => artifact.path)).toEqual([
    "worker.js",
    "redirects.json",
  ]);
});
