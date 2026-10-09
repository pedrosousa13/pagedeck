import { absentFaviconWarning } from "./favicon.js";

function absentFavicon(): string {
  const warning = absentFaviconWarning(false, []);
  if (warning === undefined) {
    throw new Error("absentFaviconWarning returned no warning for a site with no favicon");
  }
  return warning;
}

export const ABSENT_FAVICON = absentFavicon();
