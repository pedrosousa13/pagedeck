// Written by hand, unlike the derived styling safelist: these classes live in
// component source, and `safelist.test.tsx` holds this table to it both ways.

export const COMPONENT_CLASSES: Readonly<Record<string, readonly string[]>> = {
  button: ["button"],
  consent_banner: [
    "consent-banner",
    "consent-banner--settled",
    "consent-banner__accept",
    "consent-banner__actions",
    "consent-banner__body",
    "consent-banner__heading",
    "consent-banner__manage",
    "consent-banner__reject",
  ],
  feature_card: ["card"],
  feature_grid: ["grid"],
  hero: ["hero"],
  landing_page: ["landing", "landing__signup"],
  legal_page: ["legal"],
  pricing_page: ["pricing", "pricing__toggle"],
};
