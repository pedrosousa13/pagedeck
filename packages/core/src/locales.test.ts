import { expect, test } from "vitest";
import { defineLocales } from "./locales.js";
import { ConfigError } from "./exit.js";

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, but it returned");
}

test("a locale alone on a tree is unprefixed, whether or not the tree is a domain", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr" },
    ar: {
      label: "العربية",
      direction: "rtl",
      domain: "example.ae",
      fallback: "en",
    },
  });

  expect(locales.get("en")).toEqual({
    code: "en",
    label: "English",
    direction: "ltr",
    prefix: "",
  });
  expect(locales.get("ar")).toEqual({
    code: "ar",
    label: "العربية",
    direction: "rtl",
    domain: "example.ae",
    fallback: "en",
    prefix: "",
  });
});

test("locales sharing a tree are each prefixed with their own key", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr" },
    de: { label: "Deutsch", direction: "ltr" },
    fr: { label: "Français", direction: "ltr", domain: "example.fr" },
    "fr-CA": { label: "Français (CA)", direction: "ltr", domain: "example.fr" },
  });

  const placed = [...locales].map(
    ([code, locale]) => `${code} ${locale.prefix}`,
  );

  expect(placed).toEqual(["en /en", "de /de", "fr /fr", "fr-CA /fr-CA"]);
});

test("every placed locale names the code it is keyed under", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr" },
    de: { label: "Deutsch", direction: "ltr" },
    "fr-CA": { label: "Français (CA)", direction: "ltr", domain: "example.ca" },
  });

  expect([...locales].map(([code, locale]) => [code, locale.code])).toEqual([
    ["en", "en"],
    ["de", "de"],
    ["fr-CA", "fr-CA"],
  ]);
});

test("a fallback naming an undeclared locale fails, naming both locales", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", fallback: "de-AT" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Locale set: 1 locale falls back to a locale that is not declared — declare the target, or point the fallback at a declared locale:",
      '  "de" falls back to "de-AT"',
    ].join("\n"),
  );
});

test("every locale with an undeclared fallback is reported, not just the first", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", fallback: "de-AT" },
      fr: { label: "Français", direction: "ltr", fallback: "fr-CA" },
    }),
  );

  expect(failure.message).toBe(
    [
      "Locale set: 2 locales fall back to locales that are not declared — declare the target, or point the fallback at a declared locale:",
      '  "de" falls back to "de-AT"',
      '  "fr" falls back to "fr-CA"',
    ].join("\n"),
  );
});

test("a fallback named after an Object.prototype member is still undeclared", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr", fallback: "toString" },
    }),
  );

  expect(failure.message).toBe(
    [
      "Locale set: 1 locale falls back to a locale that is not declared — declare the target, or point the fallback at a declared locale:",
      '  "en" falls back to "toString"',
    ].join("\n"),
  );
});

test("a fallback chain that closes on itself is refused, with the chain printed", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr", fallback: "en-US" },
      "en-US": { label: "English (US)", direction: "ltr", fallback: "en" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Locale set: 1 fallback chain closes on itself, so resolving an untranslated page would follow it forever — remove one of the fallbacks on the cycle, or point one at a locale outside it:",
      '  "en" → "en-US" → "en"',
    ].join("\n"),
  );
});

test("a locale that falls back to itself is a cycle of one, printed as one hop", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr", fallback: "en" },
    }),
  );

  expect(failure.message).toBe(
    [
      "Locale set: 1 fallback chain closes on itself, so resolving an untranslated page would follow it forever — remove one of the fallbacks on the cycle, or point one at a locale outside it:",
      '  "en" → "en"',
    ].join("\n"),
  );
});

test("a longer cycle prints every locale on it, in the order the chain visits them", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr", fallback: "de" },
      de: { label: "Deutsch", direction: "ltr", fallback: "fr" },
      fr: { label: "Français", direction: "ltr", fallback: "en" },
    }),
  );

  expect(failure.message).toBe(
    [
      "Locale set: 1 fallback chain closes on itself, so resolving an untranslated page would follow it forever — remove one of the fallbacks on the cycle, or point one at a locale outside it:",
      '  "en" → "de" → "fr" → "en"',
    ].join("\n"),
  );
});

test("every cycle in one map is reported, not just the first", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr", fallback: "en-US" },
      "en-US": { label: "English (US)", direction: "ltr", fallback: "en" },
      de: { label: "Deutsch", direction: "ltr", fallback: "de-AT" },
      "de-AT": { label: "Deutsch (AT)", direction: "ltr", fallback: "de" },
    }),
  );

  expect(failure.message).toBe(
    [
      "Locale set: 2 fallback chains close on themselves, so resolving an untranslated page would follow one of them forever — remove one of the fallbacks on the cycle, or point one at a locale outside it:",
      '  "en" → "en-US" → "en"',
      '  "de" → "de-AT" → "de"',
    ].join("\n"),
  );
});

test("a cycle several locales fall into is reported once, as the cycle itself", () => {
  const failure = failureOf(() =>
    defineLocales({
      "de-AT": { label: "Deutsch (AT)", direction: "ltr", fallback: "de" },
      "de-CH": { label: "Deutsch (CH)", direction: "ltr", fallback: "de" },
      de: { label: "Deutsch", direction: "ltr", fallback: "en" },
      en: { label: "English", direction: "ltr", fallback: "de" },
    }),
  );

  expect(failure.message).toBe(
    [
      "Locale set: 1 fallback chain closes on itself, so resolving an untranslated page would follow it forever — remove one of the fallbacks on the cycle, or point one at a locale outside it:",
      '  "de" → "en" → "de"',
    ].join("\n"),
  );
});

test("a chain that ends in a locale with no fallback is not a cycle", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr" },
    de: { label: "Deutsch", direction: "ltr", fallback: "en" },
    "de-AT": { label: "Deutsch (AT)", direction: "ltr", fallback: "de" },
  });

  expect([...locales.keys()]).toEqual(["en", "de", "de-AT"]);
});

test("a site with no locales declared is a wiring fault", () => {
  const failure = failureOf(() => defineLocales({}));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Locale set: no locales are declared, so no page can be routed — declare at least one, like { en: { label: "English", direction: "ltr" } }',
  );
});

test("a domain carrying a path and a fragment is refused, both faults named", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", domain: "evil.com/#" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "evil.com/#…" — the domain holds a path, and this build appends each page\'s own path to it',
      '  "de": "evil.com/#…" — the domain holds a fragment, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

test("a domain that opens with a scheme is refused, and the scheme is named", () => {
  const failure = failureOf(() =>
    defineLocales({
      fr: { label: "Français", direction: "ltr", domain: "https://example.fr" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "fr": "https://example.fr" — the domain opens with the scheme "https:", and the origin supplies the scheme',
    ].join("\n"),
  );
});

test("a domain holding userinfo is refused, and the password is not printed", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: {
        label: "Deutsch",
        direction: "ltr",
        domain: "user:s3cret@example.de",
      },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "user:…@example.de" — the domain holds userinfo, and a domain is a host and nothing else',
    ].join("\n"),
  );
  expect(failure.message).not.toContain("s3cret");
});

test("a domain holding a port is refused, because the origin supplies the port", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "example.de:8080" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "example.de:8080" — the domain holds a colon, and the origin supplies the scheme and the port',
    ].join("\n"),
  );
});

test("a domain holding a query is refused", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "example.de?utm=1" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "example.de?…" — the domain holds a query, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

test("a backslash in a domain is a path, because a URL reads it as one", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "example.de\\shop" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "example.de\\\\shop" — the domain holds a path, and this build appends each page\'s own path to it',
    ].join("\n"),
  );
});

// A tab, not a space: `new URL` throws on a space, but removes a tab while
// `variantUrl` keeps it.
test("a tab in a domain is refused, which no parse of it would catch", () => {
  expect(new URL("https://exa\tmple.de").host).toBe("example.de");

  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "exa\tmple.de" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "exa\\tmple.de" — the domain holds a character that is not part of a host, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

test("a leading space in a domain is refused by the scan, ahead of the parse", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: " example.de" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": " example.de" — the domain holds a character that is not part of a host, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

test("a zero-width space in a domain is refused, and a browser resolves it to the same host", () => {
  const shared = defineLocales({
    de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
    "de-AT": { label: "Deutsch (AT)", direction: "ltr", domain: "example.de" },
  });
  expect(shared.get("de")?.prefix).toBe("/de");
  expect(shared.get("de-AT")?.prefix).toBe("/de-AT");

  expect(new URL("https://example.de\u200b").host).toBe(
    new URL("https://example.de").host,
  );

  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
      "de-AT": {
        label: "Deutsch (AT)",
        direction: "ltr",
        domain: "example.de\u200b",
      },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de-AT": "example.de\u200b" — the domain holds a character that is not part of a host, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

// On the end of the value: the parser strips a trailing C0 and throws on a leading
// or interior one.
test("a C0 control in a domain is refused, where the parser would strip it", () => {
  expect(new URL("https://example.de\u0001").host).toBe("example.de");

  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "example.de\u0001" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "example.de\\u0001" — the domain holds a character that is not part of a host, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

test("a Hangul filler in a domain is refused, though no category but default-ignorable names it", () => {
  expect(new URL("https://example.de\u3164").host).toBe(
    new URL("https://example.de").host,
  );

  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "example.de\u3164" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "example.de\u3164" — the domain holds a character that is not part of a host, and a domain is a host and nothing else',
    ].join("\n"),
  );
});

test("two IDNA spellings of one host share one tree, so both locales are prefixed", () => {
  expect(new URL("https://münchen.de").host).toBe(
    new URL("https://xn--mnchen-3ya.de").host,
  );
  const identical = defineLocales({
    de: { label: "Deutsch", direction: "ltr", domain: "xn--mnchen-3ya.de" },
    "de-AT": {
      label: "Deutsch (AT)",
      direction: "ltr",
      domain: "xn--mnchen-3ya.de",
    },
  });

  const spelled = defineLocales({
    de: { label: "Deutsch", direction: "ltr", domain: "münchen.de" },
    "de-AT": {
      label: "Deutsch (AT)",
      direction: "ltr",
      domain: "xn--mnchen-3ya.de",
    },
  });

  expect(spelled.get("de")?.prefix).toBe(identical.get("de")?.prefix);
  expect(spelled.get("de-AT")?.prefix).toBe(identical.get("de-AT")?.prefix);
  expect(spelled.get("de")?.prefix).toBe("/de");
  expect(spelled.get("de-AT")?.prefix).toBe("/de-AT");
  expect(spelled.get("de")?.domain).toBe("münchen.de");
  expect(spelled.get("de-AT")?.domain).toBe("xn--mnchen-3ya.de");
});

test("two letter-case spellings of one host share one tree, so both locales are prefixed", () => {
  const identical = defineLocales({
    de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
    "de-AT": { label: "Deutsch (AT)", direction: "ltr", domain: "example.de" },
  });

  const spelled = defineLocales({
    de: { label: "Deutsch", direction: "ltr", domain: "EXAMPLE.de" },
    "de-AT": { label: "Deutsch (AT)", direction: "ltr", domain: "example.de" },
  });

  expect(spelled.get("de")?.prefix).toBe(identical.get("de")?.prefix);
  expect(spelled.get("de-AT")?.prefix).toBe(identical.get("de-AT")?.prefix);
  expect(spelled.get("de")?.prefix).toBe("/de");
  expect(spelled.get("de-AT")?.prefix).toBe("/de-AT");
  expect(spelled.get("de")?.domain).toBe("EXAMPLE.de");
});

test("IPv4 shorthand and the dotted quad it parses to share one tree", () => {
  expect(new URL("https://127.1").host).toBe("127.0.0.1");
  expect(new URL("https://0x7f.0.0.1").host).toBe("127.0.0.1");

  const spelled = defineLocales({
    de: { label: "Deutsch", direction: "ltr", domain: "127.1" },
    "de-AT": { label: "Deutsch (AT)", direction: "ltr", domain: "0x7f.0.0.1" },
    "de-CH": { label: "Deutsch (CH)", direction: "ltr", domain: "127.0.0.1" },
  });

  expect(spelled.get("de")?.prefix).toBe("/de");
  expect(spelled.get("de-AT")?.prefix).toBe("/de-AT");
  expect(spelled.get("de-CH")?.prefix).toBe("/de-CH");
  expect(spelled.get("de")?.domain).toBe("127.1");
});

test("an empty domain is refused, rather than keying a tree named nothing", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "" — the domain is empty, and a locale served from the site\'s own origin leaves the field out',
    ].join("\n"),
  );
});

test("a domain holding a code point no host may hold is refused", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "exam|ple.de" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "exam|ple.de" — the domain is not a host, so every URL composed from it would be malformed',
    ].join("\n"),
  );
});

test("every locale with a faulty domain is reported, not just the first", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", domain: "evil.com/#" },
      fr: { label: "Français", direction: "ltr", domain: "https://example.fr" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 2 locales declare domains that are not bare hosts — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "evil.com/#…" — the domain holds a path, and this build appends each page\'s own path to it',
      '  "de": "evil.com/#…" — the domain holds a fragment, and a domain is a host and nothing else',
      '  "fr": "https://example.fr" — the domain opens with the scheme "https:", and the origin supplies the scheme',
    ].join("\n"),
  );
});

test("hosts a real site is served from are placed, not refused", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr", domain: "example.com" },
    de: { label: "Deutsch", direction: "ltr", domain: "de.example.com" },
    "de-AT": {
      label: "Deutsch (AT)",
      direction: "ltr",
      domain: "xn--mnchen-3ya.de",
    },
    fr: { label: "Français", direction: "ltr", domain: "localhost" },
    it: { label: "Italiano", direction: "ltr", domain: "example.com." },
    nl: { label: "Nederlands", direction: "ltr", domain: "[::1]" },
    es: { label: "Español", direction: "ltr" },
  });

  expect([...locales].map(([code, locale]) => [code, locale.domain])).toEqual([
    ["en", "example.com"],
    ["de", "de.example.com"],
    ["de-AT", "xn--mnchen-3ya.de"],
    ["fr", "localhost"],
    ["it", "example.com."],
    ["nl", "[::1]"],
    ["es", undefined],
  ]);
});

test("a bracketed literal with a port keeps its colon fault, and a bad one is not a host", () => {
  const withPort = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "[::1]:8080" },
    }),
  );

  expect(withPort.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "[::1]:8080" — the domain holds a colon, and the origin supplies the scheme and the port',
    ].join("\n"),
  );

  const notAnAddress = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "[::g]" },
    }),
  );

  expect(notAnAddress.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "[::g]" — the domain is not a host, so every URL composed from it would be malformed',
    ].join("\n"),
  );
});

test("a domain that is not a string is refused, naming the locale and the field", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: 123 },
      fr: { label: "Français", direction: "ltr", domain: null },
    } as unknown as Parameters<typeof defineLocales>[0]),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 2 locales declare domains that are not bare hosts — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": 123 — the domain is not a string, and a host is written as one',
      '  "fr": null — the domain is not a string, and a host is written as one',
    ].join("\n"),
  );
});

test("a faulty domain and a missing fallback are one throw of two paragraphs", () => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr" },
      de: {
        label: "Deutsch",
        direction: "ltr",
        domain: "https://example.de",
        fallback: "de-AT",
      },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "https://example.de" — the domain opens with the scheme "https:", and the origin supplies the scheme',
      "",
      "Locale set: 1 locale falls back to a locale that is not declared — declare the target, or point the fallback at a declared locale:",
      '  "de" falls back to "de-AT"',
    ].join("\n"),
  );
});

const NOT_A_HOST_NAME =
  "the domain parses to a tree key that is not a host name, so it cannot key a tree under the output directory; a host name is dot-separated labels of 1 to 63 ASCII letters, digits and hyphens, none starting or ending with a hyphen, at most 253 characters in all and optionally ending in one dot";

test.each([
  ['".."', "..", NOT_A_HOST_NAME],
  ['"."', ".", NOT_A_HOST_NAME],
  ['"%2e%2e"', "%2e%2e", NOT_A_HOST_NAME],
  ['"\u3002\u3002"', "\u3002\u3002", NOT_A_HOST_NAME],
  ['"a/b"', "a/b", "the domain holds a path, and this build appends each page's own path to it"],
  ['"a..b"', "a..b", NOT_A_HOST_NAME],
  ['"example.com.."', "example.com..", NOT_A_HOST_NAME],
  ['"-a.com"', "-a.com", NOT_A_HOST_NAME],
  ['"a-.com"', "a-.com", NOT_A_HOST_NAME],
  ["that is empty", "", "the domain is empty, and a locale served from the site's own origin leaves the field out"],
  ["with a 64-character label", `${"a".repeat(64)}.com`, NOT_A_HOST_NAME],
  ["of 254 characters", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`, NOT_A_HOST_NAME],
])("a domain %s is refused, naming the locale and the domain", (_, domain, fault) => {
  const failure = failureOf(() =>
    defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", domain },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      `  "de": ${JSON.stringify(domain)} — ${fault}`,
    ].join("\n"),
  );
});

test("a host name at the label and length limits is placed as written", () => {
  const longest = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  expect(longest).toHaveLength(253);

  const locales = defineLocales({
    en: { label: "English", direction: "ltr", domain: "example.com" },
    de: { label: "Deutsch", direction: "ltr", domain: "de.example.com" },
    fr: { label: "Français", direction: "ltr", domain: "xn--bcher-kva.example" },
    it: { label: "Italiano", direction: "ltr", domain: "localhost" },
    nl: { label: "Nederlands", direction: "ltr", domain: `${"a".repeat(63)}.example` },
    pt: { label: "Português", direction: "ltr", domain: longest },
    es: { label: "Español", direction: "ltr", domain: "a-1.EXAMPLE.com" },
  });

  expect([...locales].map(([code, locale]) => [code, locale.domain])).toEqual([
    ["en", "example.com"],
    ["de", "de.example.com"],
    ["fr", "xn--bcher-kva.example"],
    ["it", "localhost"],
    ["nl", `${"a".repeat(63)}.example`],
    ["pt", longest],
    ["es", "a-1.EXAMPLE.com"],
  ]);
});

test("a host name the URL parser reads as a malformed IPv4 address is refused", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: "256.0.0.1" },
    }),
  );

  expect(failure.message).toBe(
    [
      'Locale set: 1 locale declares a domain that is not a bare host — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      '  "de": "256.0.0.1" — the domain is not a host, so every URL composed from it would be malformed',
    ].join("\n"),
  );
});

test("every locale whose domain is not a host name is reported in one failure", () => {
  const failure = failureOf(() =>
    defineLocales({
      de: { label: "Deutsch", direction: "ltr", domain: ".." },
      "de-AT": { label: "Deutsch (AT)", direction: "ltr", domain: "-a.com" },
    }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Locale set: 2 locales declare domains that are not bare hosts — write the host a locale\'s pages are served from and nothing else, as domain: "example.de":',
      `  "de": ".." — ${NOT_A_HOST_NAME}`,
      `  "de-AT": "-a.com" — ${NOT_A_HOST_NAME}`,
    ].join("\n"),
  );
});
