import type { Page } from "./pages.js";

export interface LocaleAlternate {
  locale: string;
  declaredDomain?: string;
  output: string;
}

export function localeAlternates(
  pages: readonly Page[],
): ReadonlyMap<string, readonly LocaleAlternate[]> {
  const byPath = new Map<string, LocaleAlternate[]>();
  for (const page of pages) {
    const variants = byPath.get(page.path) ?? [];
    byPath.set(page.path, variants);
    variants.push({
      locale: page.locale,
      ...(page.declaredDomain === undefined
        ? {}
        : { declaredDomain: page.declaredDomain }),
      output: page.output,
    });
  }
  for (const variants of byPath.values()) {
    variants.sort((a, b) => {
      if (a.locale === b.locale) return 0;
      return a.locale < b.locale ? -1 : 1;
    });
  }
  return byPath;
}

/**
 * `output` is appended verbatim, not via `new URL(output, origin)`: that
 * re-spells percent-encoding and resolves dot segments (#39).
 */
export function variantUrl(
  origin: string,
  variant: Pick<LocaleAlternate, "declaredDomain" | "output">,
): string {
  const site = new URL(origin);
  const port = site.port === "" ? "" : `:${site.port}`;
  const host =
    variant.declaredDomain === undefined
      ? site.host
      : `${variant.declaredDomain}${port}`;
  return `${site.protocol}//${host}${variant.output}`;
}

export interface AlternateLink {
  readonly hreflang: string;
  readonly href: string;
}

export interface PageLinks {
  readonly canonical: string;
  readonly alternates: readonly AlternateLink[];
}

export function pageLinks(input: {
  origin: string | undefined;
  xDefault: string | undefined;
  page: Pick<Page, "declaredDomain" | "output">;
  variants: readonly LocaleAlternate[];
}): PageLinks | undefined {
  const { origin, xDefault, page, variants } = input;
  if (origin === undefined) return undefined;

  const canonical = variantUrl(origin, page);
  if (variants.length < 2) return { canonical, alternates: [] };

  const alternates = variants.map((variant) => ({
    hreflang: variant.locale,
    href: variantUrl(origin, variant),
  }));
  const fallback = alternates.find((link) => link.hreflang === xDefault);
  return {
    canonical,
    alternates:
      fallback === undefined
        ? alternates
        : [...alternates, { hreflang: "x-default", href: fallback.href }],
  };
}
