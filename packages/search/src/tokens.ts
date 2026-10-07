// Runs at build time and in the browser: a query tokenized differently finds nothing,
// silently. No stemming and no stop words.

// `\p{M}` keeps Devanagari and Thai vowel marks inside a word. No segmentation:
// `Intl.Segmenter` depends on the host's ICU, and the index must not.
const TERM = /[\p{L}\p{M}\p{N}]+/gu;

// `toLowerCase`, not `toLocaleLowerCase`, and NFC: the index must not vary with the host's
// locale.
export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize("NFC").match(TERM) ?? [];
}
