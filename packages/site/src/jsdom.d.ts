// Declared locally: `@types/jsdom` references `lib.dom`, which breaks `pnpm build`
// and `pnpm typecheck` in three packages (#289).
declare module "jsdom" {
  export interface ParsedNode {
    readonly nodeType: number;
    readonly nodeValue: string | null;
    readonly childNodes: Iterable<ParsedNode>;
  }

  export interface ParsedElement extends ParsedNode {
    readonly tagName: string;
    readonly localName: string;
    textContent: string | null;
    innerHTML: string;
    getAttribute(name: string): string | null;
    getAttributeNames(): string[];
    querySelector(selectors: string): ParsedElement | null;
    setAttribute(name: string, value: string): void;
    append(...nodes: Array<ParsedNode | string>): void;
    remove(): void;
  }

  export interface ParsedDocument {
    readonly documentElement: ParsedElement;
    readonly body: ParsedElement | null;
    querySelector(selectors: string): ParsedElement | null;
    querySelectorAll(selectors: string): Iterable<ParsedElement>;
    createElement(tagName: string): ParsedElement;
  }

  export class JSDOM {
    constructor(html: string);
    readonly window: {
      readonly document: ParsedDocument;
      readonly DOMParser: new () => {
        parseFromString(source: string, type: string): ParsedDocument;
      };
    };
  }
}
