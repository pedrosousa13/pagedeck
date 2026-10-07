import { ISLAND_FACADE_ATTRIBUTE } from "@pagedeck/islands";
import {
  CONSENT_ATTRIBUTE,
  CONSENT_DENIED,
  CONSENT_EVENT,
  CONSENT_GLOBAL,
  CONSENT_GRANTED,
} from "./consent.js";
import { shortHash } from "./manifest.js";
import { loadedScriptStrategy, resolveConsentDefault } from "./scripts.js";
import type {
  ConsentDefault,
  ScriptAttributes,
  ScriptDeclaration,
  ScriptsSetting,
} from "./scripts.js";
import type { PageIdentity } from "./page-patterns.js";

interface LoadedScript {
  readonly src: string;
  readonly attributes?: readonly string[];
  readonly gate?: ConsentGate;
}

interface ConsentGate {
  readonly category: string;
  readonly assumed: ConsentDefault;
}

export interface ScriptLayer {
  readonly placeholders: readonly FacadePlaceholder[];
  readonly elements: readonly string[];
}

export interface FacadePlaceholder {
  readonly html: string;
  readonly name: string;
  readonly mount?: string;
}

export function scriptElements(
  settings: ScriptsSetting | undefined,
  page: PageIdentity,
): ScriptLayer {
  if (settings === undefined) return { placeholders: [], elements: [] };

  const worker: ScriptDeclaration[] = [];
  const idle: LoadedScript[] = [];
  const interaction: LoadedScript[] = [];
  const facades: {
    html: string;
    name: string;
    mount?: string;
    script: LoadedScript;
  }[] = [];
  for (const script of settings.scripts) {
    // `loadedScriptStrategy`: the no-runtime fallback is already folded in.
    const strategy = loadedScriptStrategy(settings, script, page);
    if (strategy === "off") continue;
    // `necessary` is never gated: a source answering `false` for it would stop
    // the site's own consent banner from loading.
    const gate: ConsentGate | undefined =
      script.category === undefined || script.category === "necessary"
        ? undefined
        : {
            category: script.category,
            assumed: resolveConsentDefault(settings, script.category, page),
          };
    const loaded: LoadedScript = {
      src: script.src,
      attributes: attributePairs(script.attributes, script.integrity),
      gate,
    };
    switch (strategy) {
      case "worker":
        worker.push(script);
        break;
      case "idle":
        idle.push(loaded);
        break;
      case "interaction":
        interaction.push(loaded);
        break;
      case "facade":
        facades.push({
          html: script.facade?.html ?? "",
          name: script.name,
          ...(script.facade?.mount === undefined
            ? {}
            : { mount: script.facade.mount }),
          script: loaded,
        });
        break;
    }
  }

  const runtime =
    worker.length === 0 || settings.runtime === undefined
      ? []
      : settings.runtime({ scripts: worker });
  const key = facadeKey(facades);
  const placeholders = facades.map(
    ({ html, name, mount, script }, index): FacadePlaceholder => ({
      html: `<div ${ISLAND_FACADE_ATTRIBUTE}="${key}-${index}"${consentAttribute(script)}>${html}</div>`,
      name,
      ...(mount === undefined ? {} : { mount }),
    }),
  );
  const loader = loaderElement(
    idle,
    interaction,
    facades.map(({ script }) => script),
    key,
  );
  return {
    placeholders,
    elements: [...runtime, ...(loader === undefined ? [] : [loader])],
  };
}

const FACADE_KEY_LENGTH = 8;

/**
 * A digest of the facades' own markup, so no `facade.html` can state its key
 * (#316). It authenticates nothing (ADR-0006).
 */
function facadeKey(
  facades: readonly { html: string; script: LoadedScript }[],
): string {
  return shortHash(
    JSON.stringify(facades.map(({ html, script }) => [html, script.src])),
    FACADE_KEY_LENGTH,
  );
}

/**
 * Baked into the markup as well as written by `MARK`, so a stylesheet sees the
 * default before any script runs (#460).
 */
function consentAttribute({ gate }: LoadedScript): string {
  return gate === undefined ? "" : ` ${CONSENT_ATTRIBUTE}="${gate.assumed}"`;
}

function attributePairs(
  attributes: ScriptAttributes | undefined,
  integrity: string | undefined,
): readonly string[] | undefined {
  const pairs = [
    ...(attributes === undefined ? [] : Object.entries(attributes).flat()),
    ...(integrity === undefined
      ? []
      : ["integrity", integrity, "crossorigin", "anonymous"]),
  ];
  return pairs.length === 0 ? undefined : pairs;
}

const APPEND = `var load=function(u){for(var i=0;i<u.length;i++){var s=document.createElement("script");s.src=u[i];s.async=true;document.head.appendChild(s)}};`;

/**
 * Attributes before `appendChild`: a vendor may read `currentScript.dataset` as
 * soon as the element is in the document (#440).
 */
const APPEND_ATTRIBUTES = `var load=function(u){for(var i=0;i<u.length;i++){var t=u[i],s=document.createElement("script");s.src=t[0];for(var a=1;a<t.length;a+=2)s.setAttribute(t[a],t[a+1]);s.async=true;document.head.appendChild(s)}};`;

/** No `scroll`: a browser restoring a scroll position fires it unprompted. */
const INTERACTION_EVENTS = ["pointerdown", "keydown", "wheel"];

/** No `wheel`: on one element it is a visitor scrolling past it. */
const FACADE_EVENTS = ["pointerdown", "keydown"];

/**
 * Read at each decision, never cached, so a revoked category stops counting.
 */
const OK = `var ok=function(g){var c=window[${JSON.stringify(CONSENT_GLOBAL)}];return c?!!c.granted(g[1]):g[2]===1};`;

/**
 * At the trigger, not in front of it, so a gated script keeps its strategy
 * (#47).
 */
const GATE = `var gate=function(g,run){var f=function(){if(!ok(g))return;removeEventListener(${JSON.stringify(CONSENT_EVENT)},f);run(g)};if(ok(g))return run(g);addEventListener(${JSON.stringify(CONSENT_EVENT)},f)};`;

const GATE_LOAD = `var one=function(g){load([g[0]])};`;

const MARK = `var mark=function(el,g){if(g.length>1)el.setAttribute(${JSON.stringify(CONSENT_ATTRIBUTE)},ok(g)?${JSON.stringify(CONSENT_GRANTED)}:${JSON.stringify(CONSENT_DENIED)})};`;

function gateTriple(
  script: LoadedScript,
  attributed: boolean,
): readonly unknown[] {
  const entry = loadEntry(script, attributed);
  const { gate } = script;
  if (gate === undefined) return [entry];
  return [entry, gate.category, gate.assumed === CONSENT_GRANTED ? 1 : 0];
}

function loadEntry(
  { src, attributes }: LoadedScript,
  attributed: boolean,
): unknown {
  return attributed ? [src, ...(attributes ?? [])] : src;
}

function gatedList(
  scripts: readonly LoadedScript[],
  name: string,
  attributed: boolean,
): string {
  if (scripts.length === 0) return "";
  return `var ${name}=${listText(scripts.map((script) => gateTriple(script, attributed)))};`;
}

function triggerStatements(
  ungated: readonly unknown[],
  gated: readonly LoadedScript[],
  list: string,
  index: string,
): string[] {
  const statements: string[] = [];
  if (ungated.length > 0) statements.push(`load(${listText(ungated)})`);
  if (gated.length > 0) {
    statements.push(
      `for(var ${index}=0;${index}<${list}.length;${index}++)gate(${list}[${index}],one)`,
    );
  }
  return statements;
}

function loaderElement(
  idle: readonly LoadedScript[],
  interaction: readonly LoadedScript[],
  facades: readonly LoadedScript[],
  key: string,
): string | undefined {
  if (idle.length === 0 && interaction.length === 0 && facades.length === 0) {
    return undefined;
  }
  const attributed = [...idle, ...interaction].some(
    ({ attributes }) => attributes !== undefined,
  );
  const ungated = (scripts: readonly LoadedScript[]): unknown[] =>
    scripts
      .filter(({ gate }) => gate === undefined)
      .map((script) => loadEntry(script, attributed));
  const gated = (scripts: readonly LoadedScript[]): LoadedScript[] =>
    scripts.filter(({ gate }) => gate !== undefined);

  const idleGated = gated(idle);
  const interactionGated = gated(interaction);
  const facadesGated = facades.some(({ gate }) => gate !== undefined);
  const facadesAttributed = facades.some(
    ({ attributes }) => attributes !== undefined,
  );

  const body: string[] = [];
  if (idle.length > 0 || interaction.length > 0) {
    body.push(attributed ? APPEND_ATTRIBUTES : APPEND);
  }
  if (idleGated.length > 0 || interactionGated.length > 0 || facadesGated) {
    body.push(OK);
  }
  if (idleGated.length > 0 || interactionGated.length > 0) body.push(GATE);
  if (idleGated.length > 0 || interactionGated.length > 0) body.push(GATE_LOAD);
  if (idle.length > 0) {
    const statements = [
      ...triggerStatements(ungated(idle), idleGated, "gi", "n"),
    ];
    body.push(
      `${gatedList(idleGated, "gi", attributed)}var run=function(){${statements.join(";")}};if("requestIdleCallback" in window)window.requestIdleCallback(run);else setTimeout(run,0);`,
    );
  }
  if (interaction.length > 0) {
    const statements = triggerStatements(
      ungated(interaction),
      interactionGated,
      "gt",
      "m",
    );
    body.push(
      `${gatedList(interactionGated, "gt", attributed)}var events=${listText(INTERACTION_EVENTS)},fire=function(){for(var i=0;i<events.length;i++)removeEventListener(events[i],fire);${statements.join(";")}};for(var i=0;i<events.length;i++)addEventListener(events[i],fire,{passive:true});`,
    );
  }
  if (facades.length > 0) {
    const argument = facadesGated ? "g" : "src";
    const entry = facadesGated ? "g[0]" : "src";
    const source = facadesAttributed ? `${entry}[0]` : entry;
    const attributes = facadesAttributed
      ? `for(var a=1;a<${entry}.length;a+=2)s.setAttribute(${entry}[a],${entry}[a+1]);`
      : "";
    // A denied press promotes and disarms nothing, and is not deferred: an ask
    // for one embed does not keep until consent arrives (#47).
    const guard = facadesGated ? "if(g.length>1&&!ok(g))return;" : "";
    const track = facadesGated
      ? `mark(el,g);addEventListener(${JSON.stringify(CONSENT_EVENT)},function(){mark(el,g)});`
      : "";
    if (facadesGated) body.push(MARK);
    const list = listText(
      facades.map((script) =>
        facadesGated
          ? gateTriple(script, facadesAttributed)
          : loadEntry(script, facadesAttributed),
      ),
    );
    body.push(
      `var facades=${list};for(var j=0;j<facades.length;j++)(function(el,${argument}){if(!el)return;${track}var e=${listText(FACADE_EVENTS)},go=function(){${guard}for(var k=0;k<e.length;k++)el.removeEventListener(e[k],go);var s=document.createElement("script");s.src=${source};${attributes}s.async=true;s.addEventListener("load",function(){el.remove()});document.head.appendChild(s)};for(var k=0;k<e.length;k++)el.addEventListener(e[k],go,{passive:true})})(document.querySelector('[${ISLAND_FACADE_ATTRIBUTE}="${key}-'+j+'"]'),facades[j]);`,
    );
  }
  return `<script>(function(){${body.join("")}})();</script>`;
}

const LOADER_OPENINGS = [APPEND, APPEND_ATTRIBUTES, OK, "var facades="].map(
  (definition) => `(function(){${definition}`,
);

export function isScriptLoaderText(text: string): boolean {
  return LOADER_OPENINGS.some((opening) => text.startsWith(opening));
}

/**
 * Encodes every `<`, and U+2028 and U+2029 as well: unlike JSON-LD this text is
 * executed, and both end a line inside a string literal.
 */
export function listText(values: readonly unknown[]): string {
  return JSON.stringify(values)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
