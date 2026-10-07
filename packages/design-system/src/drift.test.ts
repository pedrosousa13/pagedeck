// `createRequire`, because Vitest's `import.meta` has no `resolve`. It lands in
// `dist`, as a consumer's Node does, while the `import()`s below load `src`.
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { catalog, PACKAGE_NAME, refuseForeignModules } from "./catalog.js";
import { RegistryError } from "@pagedeck/islands";

const resolve = createRequire(import.meta.url).resolve;

function report(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}

test("each row's specifier and thunk name the module its key is called after", async () => {
  const faults: string[] = [];
  for (const [name, entry] of Object.entries(catalog)) {
    if (!entry.module.startsWith(`${PACKAGE_NAME}/`)) {
      faults.push(
        `  "${name}": module "${entry.module}" is not a subpath of ${PACKAGE_NAME}`,
      );
      continue;
    }
    const resolved = resolve(entry.module);
    if (!resolved.endsWith(`/dist/components/${name}.js`)) {
      faults.push(
        `  "${name}": module "${entry.module}" resolves to ${resolved}, not to dist/components/${name}.js`,
      );
    }
    const [viaThunk, viaSpecifier] = await Promise.all([
      entry.import(),
      import(entry.module),
    ]);
    if (viaThunk !== viaSpecifier) {
      faults.push(
        `  "${name}": its thunk and its module specifier load different modules`,
      );
    }
  }
  expect(report(faults)).toBe("");
});

test("a row spelling a relative module is refused, and every bad row is named", () => {
  const thunk = (): Promise<unknown> => Promise.resolve({});
  expect(() =>
    refuseForeignModules({
      hero: { module: "./hero.js", import: thunk },
      button: { module: `${PACKAGE_NAME}/components/button`, import: thunk },
      legal_page: { module: "@other/design-system/legal", import: thunk },
    }),
  ).toThrow(
    /2 components name a module outside[\s\S]*"hero": \.\/hero\.js[\s\S]*"legal_page": @other\/design-system\/legal/,
  );
});

test("the refusal is a wiring fault, so the CLI can exit 2", () => {
  expect(() =>
    refuseForeignModules({
      hero: { module: "./hero.js", import: () => Promise.resolve({}) },
    }),
  ).toThrow(RegistryError);
});
