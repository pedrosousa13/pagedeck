const SCRIPT_SEQUENCES: readonly {
  readonly pattern: RegExp;
  readonly shown: string;
  readonly reason: string;
}[] = [
  {
    pattern: /<\/script/i,
    shown: "</script",
    reason:
      'an HTML parser ends the script element there, so the rest of the snippet is parsed as markup — write the sequence so it is not one, as "<\\/script"',
  },
  {
    pattern: /<!--/,
    shown: "<!--",
    reason:
      'an HTML parser reads it as the start of an escaped script, after which a "<script" in the same snippet stops the closing tag from closing anything — write it as "<\\!--", or use a // comment',
  },
];

const PRE_PAINT_SHAPE_FIX =
  'prePaint: ["document.documentElement.dataset.theme = localStorage.theme || \'light\'"]';

const PRE_PAINT_ENTRY_FIX =
  "write each as the JavaScript to run, with no <script> element around it";

export function prePaintFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (!Array.isArray(value)) {
    return `${where}: "build.prePaint" must be an array of scripts to run before the browser paints — ${PRE_PAINT_SHAPE_FIX}`;
  }
  // `Array.isArray` alone narrows `unknown` to `any[]`.
  const entries: readonly unknown[] = value;
  const faults = entries.flatMap((entry, index) => {
    const at = `  prePaint[${String(index)}]`;
    if (typeof entry !== "string") return [`${at} — not a string`];
    if (entry.trim() === "") {
      const reason =
        entry === "" ? "the script is empty" : "the script is only whitespace";
      return [`${at} — "${entry}" — ${reason}`];
    }
    const found = SCRIPT_SEQUENCES.find(({ pattern }) => pattern.test(entry));
    if (found !== undefined) {
      return [`${at} — holds "${found.shown}" — ${found.reason}`];
    }
    return [];
  });
  if (faults.length === 0) return undefined;
  return `${where}: "build.prePaint" declares ${String(faults.length)} ${
    faults.length === 1
      ? "entry that cannot be run before the paint"
      : "entries that cannot be run before the paint"
  } — ${PRE_PAINT_ENTRY_FIX}:\n${faults.join("\n")}`;
}
