"use client";

import { useEffect, useRef, useState } from "react";
import { CONSENT_EVENT, CONSENT_GLOBAL } from "@pagedeck/core/consent";
import { grantedBy, storeDecision, storedDecision } from "../consent.js";
import type { ConsentCategory, ConsentSource } from "@pagedeck/core/consent";
import type { ConsentDecision } from "../consent.js";

export { CONSENT_BANNER_STORAGE_KEY } from "../consent.js";

interface Browser {
  document: { getElementById(id: string): { focus(): void } | null };
  dispatchEvent(event: object): boolean;
  Event: new (type: string) => object;
}
const browser = globalThis as unknown as Browser;

// Keyed by the constant, not by a `"fwConsent"` literal that could drift from it.
const consentGlobal = globalThis as unknown as Record<
  string,
  ConsentSource | undefined
>;

const COPY_FIELDS = [
  "heading",
  "body",
  "acceptLabel",
  "rejectLabel",
  "manageLabel",
] as const;

function refuseMissingCopy(copy: Record<string, unknown>): void {
  const missing = COPY_FIELDS.filter(
    (field) => typeof copy[field] !== "string" || copy[field] === "",
  );
  if (missing.length === 0) return;
  throw new Error(
    `ConsentBanner: ${String(missing.length)} copy field${missing.length === 1 ? " is" : "s are"} missing, and a banner cannot be answered by somebody who cannot read it — give each of these a string:\n${missing
      .map((field) => `  ${field}`)
      .join("\n")}`,
  );
}

export default function ConsentBanner({
  heading,
  body,
  acceptLabel,
  rejectLabel,
  manageLabel,
  id = "fw-consent-banner",
}: {
  heading: string;
  body: string;
  acceptLabel: string;
  rejectLabel: string;
  manageLabel: string;
  // A prop rather than `useId`, whose value moves with the banner's place in the
  // tree; a site's stylesheet and tests need stable ids.
  id?: string;
}) {
  refuseMissingCopy({
    heading,
    body,
    acceptLabel,
    rejectLabel,
    manageLabel,
  });

  const [decision, setDecision] = useState<ConsentDecision | undefined>(
    undefined,
  );
  // Open on both sides of the wire: reading storage during render would mismatch
  // for every returning visitor, so the effect below closes it.
  const [open, setOpen] = useState(true);

  // Set only by a press: focusing on arrival would pull a keyboard visitor away.
  const focusAfter = useRef<string | undefined>(undefined);

  // One source object for the page's life: a site's code may keep the reference
  // it was handed.
  const answer = useRef<ConsentDecision | undefined>(undefined);
  const source = useRef<ConsentSource>({
    granted: (category: ConsentCategory) =>
      answer.current === undefined
        ? category === "necessary"
        : grantedBy(answer.current, category),
  });

  const settle = (next: ConsentDecision, focus: string): void => {
    storeDecision(next);
    setDecision(next);
    setOpen(false);
    focusAfter.current = focus;
  };

  useEffect(() => {
    const stored = storedDecision();
    if (stored === undefined) return;
    setDecision(stored);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (decision === undefined) return;
    answer.current = decision;
    // Nothing is installed before a decision, because a source overrides the site's
    // `consentDefaults`. Dispatched on every decision, so a revocation re-asks.
    consentGlobal[CONSENT_GLOBAL] = source.current;
    browser.dispatchEvent(new browser.Event(CONSENT_EVENT));
  }, [decision]);

  useEffect(() => {
    const target = focusAfter.current;
    if (target === undefined) return;
    focusAfter.current = undefined;
    // The pressed button is gone and focus is on `<body>`.
    browser.document.getElementById(target)?.focus();
  });

  const headingId = `${id}-heading`;
  const manageId = `${id}-manage`;
  const acceptId = `${id}-accept`;

  if (!open) {
    return (
      <section
        aria-label={manageLabel}
        className="consent-banner consent-banner--settled"
        id={id}
        role="region"
      >
        <button
          className="consent-banner__manage"
          id={manageId}
          onClick={() => {
            setOpen(true);
            focusAfter.current = acceptId;
          }}
          type="button"
        >
          {manageLabel}
        </button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="consent-banner"
      id={id}
      role="region"
    >
      <h2 className="consent-banner__heading" id={headingId}>
        {heading}
      </h2>
      <p className="consent-banner__body">{body}</p>
      <p className="consent-banner__actions">
        <button
          className="consent-banner__accept"
          id={acceptId}
          onClick={() => {
            settle(
              { analytics: true, functional: true, marketing: true },
              manageId,
            );
          }}
          type="button"
        >
          {acceptLabel}
        </button>
        <button
          className="consent-banner__reject"
          id={`${id}-reject`}
          onClick={() => {
            settle(
              { analytics: false, functional: false, marketing: false },
              manageId,
            );
          }}
          type="button"
        >
          {rejectLabel}
        </button>
      </p>
    </section>
  );
}
