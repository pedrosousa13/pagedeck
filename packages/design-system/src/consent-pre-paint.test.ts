// @vitest-environment jsdom
// Run by a real HTML parser through `document.write`. A window property the page
// sets is invisible here, so the verdict comes back through `document.title`.
import { expect, test } from "vitest";
import { CONSENT_GLOBAL } from "@pagedeck/core/consent";
import {
  CONSENT_BANNER_STORAGE_KEY,
  CONSENT_PRE_PAINT_SCRIPT,
  storeDecision,
  storedDecision,
} from "./consent.js";

declare const document: {
  open(): void;
  write(html: string): void;
  close(): void;
  readonly title: string;
};
declare const localStorage: {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const PROBE = `document.title=window[${JSON.stringify(
  CONSENT_GLOBAL,
)}]?["analytics","functional","marketing","necessary"].map(function(c){return c+"="+window[${JSON.stringify(
  CONSENT_GLOBAL,
)}].granted(c)}).join(" "):"none"`;

// `document.open()` replaces the document but not the window, so without this a
// page reports the source the previous test installed.
const RESET = `delete window[${JSON.stringify(CONSENT_GLOBAL)}]`;

function prePaint(): string {
  document.open();
  document.write(
    `<!doctype html><html><head><script>${RESET}</script><script>${CONSENT_PRE_PAINT_SCRIPT}</script><script>${PROBE}</script></head><body></body></html>`,
  );
  document.close();
  return document.title;
}

function earlierVisit(raw: string | undefined): void {
  localStorage.clear();
  if (raw !== undefined) localStorage.setItem(CONSENT_BANNER_STORAGE_KEY, raw);
}

const REJECTED = '{"analytics":false,"functional":false,"marketing":false}';
const ACCEPTED = '{"analytics":true,"functional":true,"marketing":true}';

const LEGACY = '{"analytics":true,"marketing":true}';

test("a returning visitor's rejection is a denial before the page has painted", () => {
  earlierVisit(REJECTED);

  expect(prePaint()).toBe(
    "analytics=false functional=false marketing=false necessary=true",
  );
});

test("a returning visitor's acceptance is a grant, in the same breath", () => {
  earlierVisit(ACCEPTED);

  expect(prePaint()).toBe(
    "analytics=true functional=true marketing=true necessary=true",
  );
});

test("a visitor who has not answered gets no source at all", () => {
  earlierVisit(undefined);

  expect(prePaint()).toBe("none");
});

test("the record the banner writes is the record the snippet reads", () => {
  localStorage.clear();
  storeDecision({ analytics: false, functional: true, marketing: true });

  expect(prePaint()).toBe(
    "analytics=false functional=true marketing=true necessary=true",
  );
});

test("a record written before the banner asked about functional is refused by both readers", () => {
  // Asserted on its own: the table below only requires the two readers to agree,
  // and they could agree on the wrong verdict.
  earlierVisit(LEGACY);

  expect(prePaint()).toBe("none");
  expect(storedDecision()).toBeUndefined();
});

const RECORDS: readonly { readonly what: string; readonly raw: string }[] = [
  { what: "a rejection", raw: REJECTED },
  { what: "an acceptance", raw: ACCEPTED },
  { what: "one category answered", raw: '{"analytics":true}' },
  { what: "a record from before functional was asked", raw: LEGACY },
  {
    what: "functional answered and nothing else",
    raw: '{"functional":true}',
  },
  {
    what: "a boolean written as a string",
    raw: '{"analytics":"true","functional":"true","marketing":"true"}',
  },
  {
    what: "functional written as a string",
    raw: '{"analytics":true,"functional":"true","marketing":true}',
  },
  {
    what: "an extra field beside every answer",
    raw: '{"analytics":false,"functional":false,"marketing":false,"v":2}',
  },
  { what: "a record that is not an object", raw: '"granted"' },
  { what: "a record that is not JSON at all", raw: "{oops" },
  { what: "an empty record", raw: "{}" },
  { what: "nothing written at all", raw: "" },
];

test("the two readers of one record agree, whatever the record is", () => {
  const fromSnippet = RECORDS.map(({ what, raw }) => {
    earlierVisit(raw === "" ? undefined : raw);
    return `${what}: ${prePaint()}`;
  });
  const fromModule = RECORDS.map(({ what, raw }) => {
    earlierVisit(raw === "" ? undefined : raw);
    const held = storedDecision();
    return `${what}: ${
      held === undefined
        ? "none"
        : `analytics=${String(held.analytics)} functional=${String(
            held.functional,
          )} marketing=${String(held.marketing)} necessary=true`
    }`;
  });

  expect(fromSnippet).toEqual(fromModule);
});

test("a snippet is text a page can carry, whatever a site does with it", () => {
  expect(CONSENT_PRE_PAINT_SCRIPT.toLowerCase()).not.toContain("</script");
  expect(CONSENT_PRE_PAINT_SCRIPT).not.toContain("<!--");
});
