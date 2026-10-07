export type ConsentCategory =
  | "analytics"
  | "functional"
  | "marketing"
  | "necessary";

export interface ConsentSource {
  granted(category: ConsentCategory): boolean;
}

export const CONSENT_GLOBAL = "fwConsent";

export const CONSENT_EVENT = "fw:consent";

export const CONSENT_ATTRIBUTE = "data-fw-consent";

export const CONSENT_GRANTED = "granted";
export const CONSENT_DENIED = "denied";
