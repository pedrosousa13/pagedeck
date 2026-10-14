import { ConfigError } from "@pagedeck/core/exit";
import {
  HEADER_NAME_LEADING_FIX,
  HEADER_NAME_TOKEN_FIX,
  OFFSITE_SOURCE_FIX,
  OFFSITE_TARGET_FIX,
  offsiteReason,
  UNSENDABLE_HEADER_VALUE_FIX,
} from "@pagedeck/core/routing";

export type Fault =
  | { kind: FaultKind; line: string }
  /** A fault only one adapter knows; faults with the same subject and fix share a paragraph. */
  | {
      kind: "adapter";
      subject: { one: string; many: string };
      fix: string;
      line: string;
    };

type FaultKind =
  | "unsupported"
  | "upstream"
  | "upstream-url-missing"
  | "upstream-url-refused"
  | "unexpressible"
  | "offsite"
  | "offsite-source"
  | "header-name"
  | "unwritable-header-name"
  | "header-value"
  | "oversize"
  | "trailing-slash"
  | "slash-only"
  | "limit";

export function treeOf(domain: string | undefined): string {
  return domain === undefined ? "the default tree" : `the "${domain}" tree`;
}

/** Each flag is true when that end was refused. */
export function refuseOffsite(
  domain: string | undefined,
  rule: { from: string; to: string },
  faults: Fault[],
): { from: boolean; to: boolean } {
  const from = JSON.stringify(rule.from);
  const fromReason = offsiteReason(rule.from, "source");
  if (fromReason !== undefined) {
    faults.push({
      kind: "offsite-source",
      line: `${treeOf(domain)}'s redirect from ${from} — ${fromReason}`,
    });
  }
  const toReason = offsiteReason(rule.to, "target");
  if (toReason !== undefined) {
    faults.push({
      kind: "offsite",
      line: `${treeOf(domain)}'s redirect target on ${from} — ${toReason}`,
    });
  }
  return { from: fromReason !== undefined, to: toReason !== undefined };
}

const UNSUPPORTED_FIX =
  "drop the experiment, or compile with an adapter that compiles a split";
const UPSTREAM_FIX =
  "compile with an adapter that routes build.routing.upstreams, or remove build.routing.upstreams and route each prefix in the host's own configuration";
const UPSTREAM_URL_MISSING_FIX =
  'set url on each to the https origin the deployed app answers at, such as "https://app.example"';
const UPSTREAM_URL_REFUSED_FIX =
  "remove url from each, and run the app where this target routes the prefix without one";
const UNEXPRESSIBLE_FIX =
  "change each value as its line says, or compile a target that can express it";
const OVERSIZE_FIX =
  "reduce the rule set, or raise the limit if the host's is higher";
const TRAILING_SLASH_FIX = 'set trailingSlash: "always"';
const SLASH_ONLY_FIX =
  "remove the redirect; this target matches a path with or without a trailing slash, so no rule can add or remove one";
const LIMIT_FIX =
  "reduce the rule set, or compile a target whose documented limit is higher";

function paragraph(
  target: string,
  count: number,
  subject: string,
  fix: string,
  lines: readonly string[],
): string {
  return `Edge target "${target}": ${String(count)} ${subject} — ${fix}:\n${lines
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

// Cause before consequence: a size measured over output with faults left out measures
// nothing that ships.
export interface Fixes {
  unsupported?: string | undefined;
  upstreamUrlMissing?: string | undefined;
  upstreamUrlRefused?: string | undefined;
}

function adapterSections(
  target: string,
  faults: readonly Fault[],
): readonly string[] {
  const groups = new Map<
    string,
    { subject: { one: string; many: string }; fix: string; lines: string[] }
  >();
  for (const fault of faults) {
    if (fault.kind !== "adapter") continue;
    const key = JSON.stringify([fault.subject.one, fault.fix]);
    const group = groups.get(key) ?? {
      subject: fault.subject,
      fix: fault.fix,
      lines: [],
    };
    group.lines.push(fault.line);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ subject, fix, lines }) =>
    paragraph(
      target,
      lines.length,
      lines.length === 1 ? subject.one : subject.many,
      fix,
      lines,
    ),
  );
}

export function throwIfAny(
  target: string,
  faults: readonly Fault[],
  fixes: Fixes = {},
): void {
  const unsupported = faults
    .filter((fault) => fault.kind === "unsupported")
    .map((fault) => fault.line);
  const upstream = faults
    .filter((fault) => fault.kind === "upstream")
    .map((fault) => fault.line);
  const urlMissing = faults
    .filter((fault) => fault.kind === "upstream-url-missing")
    .map((fault) => fault.line);
  const urlRefused = faults
    .filter((fault) => fault.kind === "upstream-url-refused")
    .map((fault) => fault.line);
  const unexpressible = faults
    .filter((fault) => fault.kind === "unexpressible")
    .map((fault) => fault.line);
  const offsite = faults
    .filter((fault) => fault.kind === "offsite")
    .map((fault) => fault.line);
  const offsiteSource = faults
    .filter((fault) => fault.kind === "offsite-source")
    .map((fault) => fault.line);
  const headerName = faults
    .filter((fault) => fault.kind === "header-name")
    .map((fault) => fault.line);
  const unwritableHeaderName = faults
    .filter((fault) => fault.kind === "unwritable-header-name")
    .map((fault) => fault.line);
  const headerValue = faults
    .filter((fault) => fault.kind === "header-value")
    .map((fault) => fault.line);
  const oversize = faults
    .filter((fault) => fault.kind === "oversize")
    .map((fault) => fault.line);
  const trailingSlash = faults
    .filter((fault) => fault.kind === "trailing-slash")
    .map((fault) => fault.line);
  const slashOnly = faults
    .filter((fault) => fault.kind === "slash-only")
    .map((fault) => fault.line);
  const limit = faults
    .filter((fault) => fault.kind === "limit")
    .map((fault) => fault.line);
  const sections: string[] = [];
  if (unsupported.length > 0) {
    sections.push(
      paragraph(
        target,
        unsupported.length,
        unsupported.length === 1
          ? "tree declares an experiment this target cannot compile"
          : "trees declare experiments this target cannot compile",
        fixes.unsupported ?? UNSUPPORTED_FIX,
        unsupported,
      ),
    );
  }
  if (upstream.length > 0) {
    sections.push(
      paragraph(
        target,
        upstream.length,
        upstream.length === 1
          ? "tree sends a prefix to an app, which this target cannot route"
          : "trees send prefixes to an app, which this target cannot route",
        UPSTREAM_FIX,
        upstream,
      ),
    );
  }
  if (urlMissing.length > 0) {
    sections.push(
      paragraph(
        target,
        urlMissing.length,
        urlMissing.length === 1
          ? "tree sends a prefix to an app with no url, which this target needs to reach the app"
          : "trees send prefixes to apps with no url, which this target needs to reach each app",
        fixes.upstreamUrlMissing ?? UPSTREAM_URL_MISSING_FIX,
        urlMissing,
      ),
    );
  }
  if (urlRefused.length > 0) {
    sections.push(
      paragraph(
        target,
        urlRefused.length,
        urlRefused.length === 1
          ? "tree sends a prefix to an app at a url, which this target does not proxy to"
          : "trees send prefixes to apps at a url, which this target does not proxy to",
        fixes.upstreamUrlRefused ?? UPSTREAM_URL_REFUSED_FIX,
        urlRefused,
      ),
    );
  }
  sections.push(...adapterSections(target, faults));
  if (unexpressible.length > 0) {
    sections.push(
      paragraph(
        target,
        unexpressible.length,
        unexpressible.length === 1
          ? "value cannot be expressed by this target"
          : "values cannot be expressed by this target",
        UNEXPRESSIBLE_FIX,
        unexpressible,
      ),
    );
  }
  if (offsite.length > 0) {
    sections.push(
      paragraph(
        target,
        offsite.length,
        offsite.length === 1
          ? "redirect target is not a path on this site"
          : "redirect targets are not paths on this site",
        OFFSITE_TARGET_FIX,
        offsite,
      ),
    );
  }
  if (offsiteSource.length > 0) {
    sections.push(
      paragraph(
        target,
        offsiteSource.length,
        offsiteSource.length === 1
          ? "redirect source is not a path on this site"
          : "redirect sources are not paths on this site",
        OFFSITE_SOURCE_FIX,
        offsiteSource,
      ),
    );
  }
  if (headerName.length > 0) {
    sections.push(
      paragraph(
        target,
        headerName.length,
        headerName.length === 1
          ? "header name is not a token"
          : "header names are not tokens",
        HEADER_NAME_TOKEN_FIX,
        headerName,
      ),
    );
  }
  if (unwritableHeaderName.length > 0) {
    sections.push(
      paragraph(
        target,
        unwritableHeaderName.length,
        unwritableHeaderName.length === 1
          ? "header name cannot be written to a line-based headers file"
          : "header names cannot be written to a line-based headers file",
        HEADER_NAME_LEADING_FIX,
        unwritableHeaderName,
      ),
    );
  }
  if (headerValue.length > 0) {
    sections.push(
      paragraph(
        target,
        headerValue.length,
        headerValue.length === 1
          ? "header value cannot be sent"
          : "header values cannot be sent",
        UNSENDABLE_HEADER_VALUE_FIX,
        headerValue,
      ),
    );
  }
  if (oversize.length > 0) {
    sections.push(
      paragraph(
        target,
        oversize.length,
        oversize.length === 1
          ? "artifact exceeds its size limit"
          : "artifacts exceed their size limit",
        OVERSIZE_FIX,
        oversize,
      ),
    );
  }
  if (trailingSlash.length > 0) {
    sections.push(
      paragraph(
        target,
        trailingSlash.length,
        trailingSlash.length === 1
          ? "tree cannot serve the site's trailingSlash policy"
          : "trees cannot serve the site's trailingSlash policy",
        TRAILING_SLASH_FIX,
        trailingSlash,
      ),
    );
  }
  if (slashOnly.length > 0) {
    sections.push(
      paragraph(
        target,
        slashOnly.length,
        slashOnly.length === 1
          ? "redirect differs from its target only by a trailing slash"
          : "redirects differ from their targets only by a trailing slash",
        SLASH_ONLY_FIX,
        slashOnly,
      ),
    );
  }
  if (limit.length > 0) {
    sections.push(
      paragraph(
        target,
        limit.length,
        limit.length === 1
          ? "value exceeds a limit this target documents"
          : "values exceed a limit this target documents",
        LIMIT_FIX,
        limit,
      ),
    );
  }
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));
}
