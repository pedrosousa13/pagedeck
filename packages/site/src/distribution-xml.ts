import { ConfigError } from "@pagedeck/core";

/**
 * The XML CloudFront's API speaks for a `DistributionConfig`: elements, character data, the root's
 * `xmlns`. An element holds either other elements or text, never both. Anything else is refused,
 * so an operator's field is either carried through exactly or the run stops.
 */
export interface XmlElement {
  name: string;
  attributes: [string, string][];
  children: XmlElement[];
  text: string;
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const NAME = /[A-Za-z_][\w.-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

export function readXml(xml: string, source: string): XmlElement {
  let at = 0;
  const fail = (what: string): never => {
    throw new ConfigError(
      `${source}: the XML has ${what} at character ${String(at)} — this reader takes the DistributionConfig shape CloudFront's API documents and nothing else; compare the response with https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_GetDistributionConfig.html`,
    );
  };
  const decode = (raw: string): string =>
    raw.replace(/&(#x[0-9A-Fa-f]+|#\d+|\w+);|&/g, (whole, entity: string | undefined) => {
      if (entity === undefined) return fail("a bare &");
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return NAMED[entity] ?? fail(`the unknown entity ${whole}`);
    });
  const skipSpace = (): void => {
    while (at < xml.length && /\s/.test(xml[at] as string)) at += 1;
  };
  const name = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(xml);
    if (match === null) return fail("no element name");
    at = NAME.lastIndex;
    return match[0];
  };
  const element = (): XmlElement => {
    if (xml.startsWith("<!--", at)) return fail("a comment");
    if (xml.startsWith("<![CDATA[", at)) return fail("a CDATA section");
    if (xml.startsWith("<!", at)) return fail("a DOCTYPE");
    if (xml.startsWith("<?", at)) return fail("a processing instruction");
    if (xml[at] !== "<") return fail("text where an element belongs");
    at += 1;
    const node: XmlElement = { name: name(), attributes: [], children: [], text: "" };
    for (;;) {
      ATTRIBUTE.lastIndex = at;
      const match = ATTRIBUTE.exec(xml);
      if (match === null) break;
      node.attributes.push([match[1] as string, decode(match[2] ?? match[3] ?? "")]);
      at = ATTRIBUTE.lastIndex;
    }
    skipSpace();
    if (xml.startsWith("/>", at)) {
      at += 2;
      return node;
    }
    if (xml[at] !== ">") return fail(`a malformed start tag <${node.name}>`);
    at += 1;
    const start = at;
    const textEnd = xml.indexOf("<", at);
    if (textEnd === -1) return fail(`no close for <${node.name}>`);
    const raw = xml.slice(start, textEnd);
    at = textEnd;
    if (!xml.startsWith("</", at)) {
      if (raw.trim() !== "") return fail(`text beside elements in <${node.name}>`);
      while (!xml.startsWith("</", at)) {
        node.children.push(element());
        skipSpace();
        if (at >= xml.length) return fail(`no close for <${node.name}>`);
      }
    } else {
      node.text = decode(raw);
    }
    at += 2;
    if (name() !== node.name) return fail(`a close tag that does not match <${node.name}>`);
    skipSpace();
    if (xml[at] !== ">") return fail(`a malformed close tag </${node.name}>`);
    at += 1;
    return node;
  };

  if (xml.charCodeAt(0) === 0xfeff) at = 1;
  skipSpace();
  if (xml.startsWith("<?xml", at)) {
    const end = xml.indexOf("?>", at);
    if (end === -1) return fail("an unclosed XML declaration");
    at = end + 2;
  }
  skipSpace();
  const root = element();
  skipSpace();
  if (at !== xml.length) fail("content after the root element");
  return root;
}

const escapeText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (value: string): string => escapeText(value).replaceAll('"', "&quot;");

export function writeXml(root: XmlElement): string {
  const lines: string[] = [XML_DECLARATION];
  const write = (node: XmlElement, indent: string): void => {
    const open = `<${node.name}${node.attributes.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join("")}>`;
    if (node.children.length === 0) {
      lines.push(`${indent}${open}${escapeText(node.text)}</${node.name}>`);
      return;
    }
    lines.push(`${indent}${open}`);
    for (const one of node.children) write(one, `${indent}  `);
    lines.push(`${indent}</${node.name}>`);
  };
  write(root, "");
  return `${lines.join("\n")}\n`;
}

export function element(name: string, content: string | XmlElement[]): XmlElement {
  return typeof content === "string"
    ? { name, attributes: [], children: [], text: content }
    : { name, attributes: [], children: content, text: "" };
}

export function children(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((one) => one.name === name);
}

export function child(node: XmlElement, name: string): XmlElement {
  const found = node.children.find((one) => one.name === name);
  if (found === undefined) return element(name, "");
  return found;
}

export function text(node: XmlElement): string {
  return node.text;
}
