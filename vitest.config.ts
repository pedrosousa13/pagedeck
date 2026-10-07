import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PACKAGES = fileURLToPath(new URL("./packages/", import.meta.url));

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every `@pagedeck/*` specifier that has a `source` condition, pointed back at the
 * package's own source.
 *
 * Every package emits real JavaScript (`pnpm build`) and its `exports` send Node
 * to `dist`, because Node cannot execute a `.tsx` and cannot resolve the `.js`
 * specifiers a `.ts` source carries (#177, #182). The suite must not follow it
 * there: Vitest transforms this source itself, and a test that resolved a
 * workspace package to `dist` would measure the last build rather than the
 * working tree — and would load two copies of a package whose errors other
 * packages catch by class.
 *
 * Read from each package's own `source` condition rather than listed here, so
 * that a new subpath export is aliased by declaring it once.
 *
 * A subpath whose target is a plain string is skipped rather than refused. No
 * package has one today, and `packages/core/src/workspace-packages.test.ts` is
 * what says so; this file's job is aliasing, and it has nothing to alias a bare
 * string from. A subpath that carries conditions but no usable `source` *is* a
 * fault, and is refused by name — `AGENTS.md` states the three-condition rule,
 * and a rule written only in prose is one this file would otherwise let a
 * contributor break silently.
 */
function workspaceSourceAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = [];
  // Collected rather than thrown one at a time: a contributor adding a subpath
  // export usually adds it to more than one package, and being told about the
  // second one only after fixing the first is two runs to learn one thing.
  const faults: string[] = [];

  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, "package.json");
    // `readdirSync` answers with every entry under `packages/`, and only the
    // ones holding a manifest are packages. **No directory is in that gap
    // today** — `packages/site` was the one this comment used to name, and #56
    // gave it a manifest, at which point the rule
    // `packages/core/src/workspace-packages.test.ts` states took it with
    // nothing to decide. The check stays because what it guards is the walk and
    // not that one directory: a stray file or a scratch directory beside the
    // packages would otherwise reach `readFileSync` and be reported as a
    // package whose manifest is malformed, which names the wrong fault. A
    // manifest that is there and unreadable is a different thing, and is
    // reported as one below.
    if (!existsSync(manifest)) continue;
    let parsed: { name?: string; exports?: unknown };
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8")) as typeof parsed;
    } catch (cause) {
      faults.push(
        `Package manifest "${manifest}": is not valid JSON — ${String(cause)}`,
      );
      continue;
    }
    const { name, exports } = parsed;
    if (name === undefined || typeof exports !== "object" || exports === null) {
      continue;
    }

    for (const [subpath, target] of Object.entries(
      exports as Record<string, unknown>,
    )) {
      // A bare-string target: nothing to read a `source` condition off.
      if (typeof target !== "object" || target === null) continue;

      const specifier = name + subpath.slice(1);
      const source = (target as Record<string, unknown>).source;
      if (typeof source !== "string") {
        faults.push(
          `Package "${name}": exports subpath "${subpath}" declares conditions but no "source", so Vitest would resolve ${specifier} to dist and the suite would measure the last build — add "source" ahead of "types" and "default", pointing at the .ts or .tsx under src that the other two describe; "types" points at the emitted .d.ts now, so it is not the target to copy`,
        );
        continue;
      }
      const resolved = join(PACKAGES, dir, source);
      const star = specifier.indexOf("*");
      if (star === -1) {
        if (!existsSync(resolved)) {
          faults.push(
            `Package "${name}": exports subpath "${subpath}" points "source" at "${source}", which is not there — name the file the package really has`,
          );
          continue;
        }
        // Anchored, because a bare string `find` also matches every specifier
        // under it: `@pagedeck/core` would swallow `@pagedeck/core/build` and resolve it to
        // the index.
        aliases.push({
          find: new RegExp(`^${escapeRegExp(specifier)}$`),
          replacement: resolved,
        });
        continue;
      }

      // A wildcard subpath — `@pagedeck/design-system/components/*`. Node substitutes
      // whatever the `*` matched into the target's own `*`, so the alias has to
      // do the same: a capture group where the specifier's star is, `$1` where
      // the target's is. A one-file alias would resolve every component to the
      // same module.
      //
      // `(.+)` rather than `(.*)`, which is one case narrower than Node: Node's
      // `*` also matches the empty string, so `@pagedeck/design-system/components/`
      // resolves for it and not here. Nothing writes that specifier, and a
      // pattern export whose useful match is "" would be a package exporting a
      // file it could name directly. Widen this if that ever stops being true.
      const sourceStar = resolved.indexOf("*");
      if (sourceStar === -1) {
        faults.push(
          `Package "${name}": exports subpath "${subpath}" is a wildcard but points "source" at "${source}", which holds no "*" — give the target a "*" for the subpath's to substitute into`,
        );
        continue;
      }
      // Checked as far as a pattern can be: the directory the matches come out
      // of. Which files are in it is the consumer's choice, so there is no one
      // path to test for.
      //
      // The prefix gets a character appended before `dirname` reads it, because
      // it ends at the `*` and so usually ends in a separator — and `dirname`
      // strips a trailing separator before taking the parent, which would test
      // the directory above the one the matches are in.
      if (!existsSync(dirname(`${resolved.slice(0, sourceStar)}x`))) {
        faults.push(
          `Package "${name}": exports subpath "${subpath}" points "source" at "${source}", whose directory is not there — name the directory the package really has`,
        );
        continue;
      }
      aliases.push({
        find: new RegExp(
          `^${escapeRegExp(specifier.slice(0, star))}(.+)${escapeRegExp(specifier.slice(star + 1))}$`,
        ),
        // `$1` is `String.prototype.replace`'s, which is what Vite applies a
        // regular-expression alias with. Nothing else in the replacement is a
        // substitution pattern: it is an absolute path under this repo, and a
        // `$` in one would have to be in a directory name.
        replacement: `${resolved.slice(0, sourceStar)}$1${resolved.slice(sourceStar + 1)}`,
      });
    }
  }

  if (faults.length > 0) {
    throw new Error(
      `Workspace exports: ${String(faults.length)} subpath${faults.length === 1 ? "" : "s"} cannot be aliased to source, so the suite would not be measuring the working tree:\n  ${faults.join("\n  ")}`,
    );
  }
  return aliases;
}

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    // A floor against worker starvation under the suite's own load, not a budget
    // for slow cases (#640).
    testTimeout: 15_000,
  },
});
