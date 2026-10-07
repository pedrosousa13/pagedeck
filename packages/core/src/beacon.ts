import { CONSENT_GLOBAL } from "./consent.js";
import { quote, quoteAddress } from "./quote.js";
import { DEFAULT_CONSENT, resolveConsentDefault } from "./scripts.js";
import { listText } from "./script-elements.js";
import type { ConsentCategory } from "./consent.js";
import type { PageIdentity } from "./page-patterns.js";
import type { ScriptsSetting } from "./scripts.js";

export interface BeaconSetting {
  readonly endpoint: string;
}

export const BEACON_CATEGORY: ConsentCategory = "analytics";

const BEACON_FIX = 'beacon: { endpoint: "https://example.com/rum" }';

const BEACON_FIELDS = ["endpoint"];

export function beaconFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.beacon" must be an object saying where real-user metrics are sent — ${BEACON_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const faults: string[] = [];

  const unknown = Object.keys(record).filter(
    (key) => !BEACON_FIELDS.includes(key),
  );
  for (const key of unknown) {
    faults.push(
      `${quote(key)} is not a field this build reads — delete it, or correct it to: ${BEACON_FIELDS.join(", ")}`,
    );
  }

  const endpoint = Object.hasOwn(record, "endpoint")
    ? record["endpoint"]
    : undefined;
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    faults.push(
      `endpoint is ${typeof endpoint === "string" ? quoteAddress(endpoint) : quote(endpoint)}, and the beacon has nowhere to report to — name an absolute https: URL or a path on this site, such as "/rum"`,
    );
  } else {
    faults.push(...endpointFaults(endpoint));
  }

  if (faults.length === 0) return undefined;
  return `${where}: "build.beacon" cannot be used as declared — ${BEACON_FIX}:\n${faults
    .map((fault) => `  ${fault}`)
    .join("\n")}`;
}

function endpointFaults(endpoint: string): string[] {
  const shown = quoteAddress(endpoint);
  if (endpoint.startsWith("//")) {
    return [
      `endpoint ${shown} is protocol-relative, so it names a host and not a path on this site — write the scheme, as https://example.com/rum`,
    ];
  }
  if (endpoint.startsWith("/")) return [];

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [
      `endpoint ${shown} is neither an absolute URL nor a path on this site — write https://example.com/rum, or /rum`,
    ];
  }
  const faults: string[] = [];
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    faults.push(
      `endpoint ${shown} has the scheme "${url.protocol}", and a browser reports over http: or https: — write https://example.com/rum`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    faults.push(
      `endpoint ${shown} carries userinfo, and this URL is written into every page of the site — take the credential out, and authenticate the collector another way`,
    );
  }
  return faults;
}

const OBSERVE = `var o=function(t,f,d){try{new PerformanceObserver(f).observe({type:t,buffered:true,durationThreshold:d})}catch(e){}};`;

const LCP = `o("largest-contentful-paint",function(l){var e=l.getEntries(),v=e[e.length-1];if(v)m.lcp=Math.round(v.startTime)});`;

const CLS = `var c=0,f=0,p=0;o("layout-shift",function(l){var e=l.getEntries();for(var i=0;i<e.length;i++){var s=e[i];if(s.hadRecentInput)continue;if(c&&s.startTime-p<1000&&s.startTime-f<5000)c+=s.value;else{c=s.value;f=s.startTime}p=s.startTime;if(c>(m.cls||0))m.cls=Math.round(c*1e4)/1e4}});`;

/**
 * 40 ms matches `web-vitals`; the browser's default `durationThreshold` of 104
 * ms would hide every faster interaction for the whole visit.
 */
const INP_THRESHOLD = 40;

/**
 * The worst interaction, deliberately not INP's 98th percentile, which would
 * need every interaction kept and sorted.
 */
const INP = `o("event",function(l){var e=l.getEntries();for(var i=0;i<e.length;i++){var s=e[i];if(s.interactionId&&s.duration>(m.inp||0))m.inp=Math.round(s.duration)}},${INP_THRESHOLD});`;

/**
 * `sent` is set only once a transport took the payload, never before the gate.
 * Both `visibilitychange` and `pagehide`: neither fires reliably alone.
 */
const SEND = `var sent,send=function(){if(sent)return;var g=window[${JSON.stringify(CONSENT_GLOBAL)}];if(!(g?!!g.granted(${JSON.stringify(BEACON_CATEGORY)}):q[3]===1))return;m.locale=q[1];m.path=q[2];var b=JSON.stringify(m);if(!(navigator.sendBeacon&&navigator.sendBeacon(q[0],b)))fetch(q[0],{method:"POST",body:b,keepalive:true});sent=1};addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")send()});addEventListener("pagehide",send);`;

export function beaconElement(
  beacon: BeaconSetting | undefined,
  scripts: ScriptsSetting | undefined,
  page: PageIdentity,
): string | undefined {
  if (beacon === undefined) return undefined;
  const fallback =
    scripts === undefined
      ? DEFAULT_CONSENT
      : resolveConsentDefault(scripts, BEACON_CATEGORY, page);
  const q = listText([
    beacon.endpoint,
    page.locale,
    page.path,
    fallback === "granted" ? 1 : 0,
  ]);
  return `<script>${OPENING}${q},m={};${OBSERVE}var start=function(){${LCP}${CLS}${INP}};if("requestIdleCallback" in window)requestIdleCallback(start);else setTimeout(start,0);${CLOSING}</script>`;
}

const OPENING = "(function(){var q=";

const CLOSING = `${SEND}})();`;

export function isBeaconText(text: string): boolean {
  return text.startsWith(OPENING) && text.endsWith(CLOSING);
}
