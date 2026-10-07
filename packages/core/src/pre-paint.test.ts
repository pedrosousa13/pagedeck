import { expect, test } from "vitest";
import { prePaintFaultReport } from "./pre-paint.js";

const WHERE = 'Config "/site/pagedeck.config.ts"';

const SHAPE_FIX =
  'prePaint: ["document.documentElement.dataset.theme = localStorage.theme || \'light\'"]';

const ENTRY_FIX =
  "write each as the JavaScript to run, with no <script> element around it";

test("a value that is not an array is refused, with the shape in the fix", () => {
  expect(prePaintFaultReport("theme()", WHERE)).toBe(
    `${WHERE}: "build.prePaint" must be an array of scripts to run before the browser paints — ${SHAPE_FIX}`,
  );
});

test("a snippet that would end its own element is refused, with the edit", () => {
  expect(prePaintFaultReport(["var end = '</script>'"], WHERE)).toBe(
    `${WHERE}: "build.prePaint" declares 1 entry that cannot be run before the paint — ${ENTRY_FIX}:\n` +
      `  prePaint[0] — holds "</script" — an HTML parser ends the script element there, so the rest of the snippet is parsed as markup — write the sequence so it is not one, as "<\\/script"`,
  );
});

test("the closing tag is refused however it is cased, because the parser is", () => {
  const report = prePaintFaultReport(["var end = '</SCRIPT>'"], WHERE);

  expect(report).toContain('prePaint[0] — holds "</script"');
});

test("an HTML comment opener is refused too, for what it does after it", () => {
  expect(prePaintFaultReport(["var open = '<!--<script>'"], WHERE)).toBe(
    `${WHERE}: "build.prePaint" declares 1 entry that cannot be run before the paint — ${ENTRY_FIX}:\n` +
      `  prePaint[0] — holds "<!--" — an HTML parser reads it as the start of an escaped script, after which a "<script" in the same snippet stops the closing tag from closing anything — write it as "<\\!--", or use a // comment`,
  );
});

test("a comparison is not a closing tag, and is not refused", () => {
  expect(
    prePaintFaultReport(["for (var i = 0; i < 3; i++) tick(i)"], WHERE),
  ).toBe(undefined);
});

test("every unusable entry is reported in one run, named by index", () => {
  const report = prePaintFaultReport(
    ["</script>", "ok()", 7, "   ", ""],
    WHERE,
  );

  expect(report).toBe(
    `${WHERE}: "build.prePaint" declares 4 entries that cannot be run before the paint — ${ENTRY_FIX}:\n` +
      `  prePaint[0] — holds "</script" — an HTML parser ends the script element there, so the rest of the snippet is parsed as markup — write the sequence so it is not one, as "<\\/script"\n` +
      `  prePaint[2] — not a string\n` +
      `  prePaint[3] — "   " — the script is only whitespace\n` +
      `  prePaint[4] — "" — the script is empty`,
  );
});

test("a site that declared an empty list has declared nothing to refuse", () => {
  expect(prePaintFaultReport([], WHERE)).toBe(undefined);
});
