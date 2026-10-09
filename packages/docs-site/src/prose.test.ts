import { expect, test } from "vitest";
import { focusablePre, wrapTables } from "./prose.js";

test("every table is put in a scroll container a keyboard can reach", () => {
  expect(
    wrapTables("<p>a</p><table><tr><td>1</td></tr></table><table>\n</table>"),
  ).toBe(
    '<p>a</p><div class="fw-table" tabindex="0"><table><tr><td>1</td></tr></table></div>' +
      '<div class="fw-table" tabindex="0"><table>\n</table></div>',
  );
});

test("a table quoted in a code sample is escaped markup, and is left alone", () => {
  const quoted = "<pre><code>&#x3C;table>&#x3C;/table></code></pre>";
  expect(wrapTables(quoted)).toBe(quoted);
});

test("a code block the highlighter did not colour is made focusable, so a keyboard can scroll it", () => {
  expect(
    focusablePre('<pre><code>x</code></pre><pre class="shiki" tabindex="0"><code>y</code></pre>'),
  ).toBe('<pre tabindex="0"><code>x</code></pre><pre class="shiki" tabindex="0"><code>y</code></pre>');
});
