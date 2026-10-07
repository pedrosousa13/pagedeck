import { registerHooks } from "node:module";

export interface StylesheetStubInstall {
  close(): void;
}

/**
 * `.css` only: stubbing `.scss` or `.less`, which reach Vite through a site's
 * plugin, would make a build green whose CSS is missing their rules.
 */
const STYLESHEET = ".css";

export function installStylesheetStubs(): StylesheetStubInstall {
  const hooks = registerHooks({
    load: (url, context, nextLoad) => {
      if (!isStylesheet(url)) return nextLoad(url, context);
      return { format: "module", shortCircuit: true, source: "export {};\n" };
    },
  });
  return { close: () => hooks.deregister() };
}

function isStylesheet(url: string): boolean {
  const query = url.indexOf("?");
  return (query === -1 ? url : url.slice(0, query)).endsWith(STYLESHEET);
}
