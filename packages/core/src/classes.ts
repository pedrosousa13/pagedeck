const NAME_CHARACTER = "[-\\w]";

const CLASS_ATTRIBUTE = new RegExp(
  `(?<!${NAME_CHARACTER})class(?!${NAME_CHARACTER})\\s*=\\s*` +
    `(?:"([^"]*)"|'([^']*)'|([^\\s>&"'=<\`]*))`,
  "gi",
);

const ASCII_WHITESPACE = /[ \t\n\f\r]+/;

const CHARACTER_REFERENCES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#x27;", "'"],
]);

const CHARACTER_REFERENCE = /&(?:amp|lt|gt|quot|#x27);/g;

function decode(token: string): string {
  return token.replace(
    CHARACTER_REFERENCE,
    (reference) => CHARACTER_REFERENCES.get(reference) ?? reference,
  );
}

export function classesOfHtml(html: string): string[] {
  const classes = new Set<string>();
  for (const match of html.matchAll(CLASS_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    for (const token of value.split(ASCII_WHITESPACE)) {
      if (token !== "") classes.add(decode(token));
    }
  }
  return [...classes];
}
