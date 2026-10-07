// The package's own name, not `./src/site.js`: Node strips types and cannot
// resolve a `.js` only `tsc` emits (#182).
import { siteConfig } from "@pagedeck/site";

export default siteConfig();
