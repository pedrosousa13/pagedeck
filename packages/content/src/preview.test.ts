import { expect, test, vi } from "vitest";
import { MAX_PREVIEW_BYTES, excerpt, imagePreviewFault } from "./preview.js";

const PAYLOAD = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

test.each(["png", "jpeg", "webp", "avif", "gif"])(
  "a base64 %s data URI is a preview",
  (type) => {
    expect(imagePreviewFault(`data:image/${type};base64,${PAYLOAD}`)).toBeUndefined();
  },
);

test("each padding a base64 payload can end in is accepted", () => {
  expect(imagePreviewFault("data:image/png;base64,AAAA")).toBeUndefined();
  expect(imagePreviewFault("data:image/png;base64,AAA=")).toBeUndefined();
  expect(imagePreviewFault("data:image/png;base64,AA==")).toBeUndefined();
});

const NOT_A_PREVIEW =
  "not a base64 data URI of a png, jpeg, webp, avif or gif image";
const NOT_BASE64 =
  "its payload is not base64 — only A-Z, a-z, 0-9, + and / in groups of four, the last padded with =";

test.each([
  ["a double quote", `data:image/png;base64,AAAA");background:url("https://x.example/`, NOT_BASE64],
  ["a single quote", "data:image/png;base64,AA'A", NOT_BASE64],
  ["a closing parenthesis", "data:image/png;base64,AAAA)", NOT_BASE64],
  ["a semicolon", "data:image/png;base64,AAAA;color:red", NOT_BASE64],
  ["a backslash", "data:image/png;base64,AA\\29", NOT_BASE64],
  ["a newline", "data:image/png;base64,AAAA\n", NOT_BASE64],
  ["a newline before the payload", "data:image/png;base64,\nAAAA", NOT_BASE64],
  ["a closing style tag", "data:image/png;base64,AAAA</style>", NOT_BASE64],
  ["a space", "data:image/png;base64,AA AA", NOT_BASE64],
  ["a URL-safe base64 character", "data:image/png;base64,AA-_", NOT_BASE64],
  ["padding in the middle", "data:image/png;base64,AA==AAAA", NOT_BASE64],
  ["a payload of a wrong length", "data:image/png;base64,AAAAA", NOT_BASE64],
  ["an empty payload", "data:image/png;base64,", NOT_BASE64],
  ["a javascript: URL", "javascript:alert(1)", NOT_A_PREVIEW],
  ["an SVG data URI", `data:image/svg+xml;base64,${PAYLOAD}`, NOT_A_PREVIEW],
  ["a data URI that is not base64", "data:image/png,AAAA", NOT_A_PREVIEW],
  ["a data URI with a parameter", "data:image/png;charset=utf-8;base64,AAAA", NOT_A_PREVIEW],
  ["an upper-case scheme", "DATA:image/png;base64,AAAA", NOT_A_PREVIEW],
  ["leading whitespace", " data:image/png;base64,AAAA", NOT_A_PREVIEW],
  ["a remote URL", "https://cdn.example/hero.jpg?w=16", NOT_A_PREVIEW],
  ["the empty string", "", NOT_A_PREVIEW],
])("an answer holding %s is refused", (_name, answer, reason) => {
  expect(imagePreviewFault(answer)).toBe(reason);
});

test.each([
  ["a number", 17],
  ["null", null],
  ["an object", { src: "data:image/png;base64,AAAA" }],
])("an answer that is %s is refused as not a string", (_name, answer) => {
  expect(imagePreviewFault(answer)).toBe("not a string");
});

test("an answer under the cap passes, and one over it is refused with its size and the cap", () => {
  const prefix = "data:image/png;base64,";
  // 22 + 2024 = 2046 bytes, the longest well-formed png answer the cap admits.
  const under = prefix + "A".repeat(2020) + "AA==";
  const over = `${prefix}${"A".repeat(2028)}`;

  expect(under.length).toBe(MAX_PREVIEW_BYTES - 2);
  expect(imagePreviewFault(under)).toBeUndefined();
  expect(imagePreviewFault(over)).toBe(
    `at least ${String(over.length)} bytes, over the ${String(MAX_PREVIEW_BYTES)}-byte cap`,
  );
});

test("an answer longer than the cap is refused without being encoded", () => {
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    const huge = `data:image/png;base64,${"A".repeat(10_000_000)}`;

    expect(imagePreviewFault(huge)).toBe(
      `at least ${String(huge.length)} bytes, over the ${String(MAX_PREVIEW_BYTES)}-byte cap`,
    );
    expect(encode).not.toHaveBeenCalled();
  } finally {
    encode.mockRestore();
  }
});

test("the cap counts bytes, not characters", () => {
  const prefix = "data:image/png;base64,";
  const answer = prefix + "é".repeat(MAX_PREVIEW_BYTES / 2);

  expect(answer.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  expect(imagePreviewFault(answer)).toBe("2070 bytes, over the 2048-byte cap");
});

test("the cap is 2 KiB", () => {
  expect(MAX_PREVIEW_BYTES).toBe(2048);
});

test("an excerpt cuts a long answer at 32 characters and leaves anything else alone", () => {
  expect(excerpt("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(
    "data:image/svg+xml;base64,PHN2Zz…",
  );
  expect(excerpt("javascript:alert(1)")).toBe("javascript:alert(1)");
  expect(excerpt(17)).toBe(17);
});
