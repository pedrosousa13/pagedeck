export type ConsentCategory =
  | "analytics"
  | "functional"
  | "marketing"
  | "necessary";

export interface ConsentSource {
  granted(category: ConsentCategory): boolean;
}

export const CONSENT_GLOBAL = "pagedeckConsent";

export const CONSENT_EVENT = "pagedeck:consent";

export const CONSENT_ATTRIBUTE = "data-pagedeck-consent";

/** The consent banner's default `id`, which it and its focus targets are looked up by. */
export const CONSENT_BANNER_ID = "pagedeck-consent-banner";

export const CONSENT_GRANTED = "granted";
export const CONSENT_DENIED = "denied";
