import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { netlifyStatus } from "./encode.js";
import { netlify } from "./index.js";
import { interpretNetlify } from "./interpret.test-support.js";

describeConformance({
  adapter: netlify(),
  interpret: interpretNetlify,
  servedStatus: netlifyStatus,
  policies: ["never", "always"],
  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ : "You cannot use a
  // redirect rule to add or remove a trailing slash."
  noSlashRedirects: true,
});
