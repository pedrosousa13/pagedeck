import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { cloudflareWorker } from "./index.js";
import { interpretWorker } from "./interpret.test-support.js";
import { NO_URL_FIX } from "./upstreams.js";

describeConformance({
  adapter: cloudflareWorker(),
  interpret: interpretWorker,
  policies: ["never", "always"],
  upstreams: { withUrl: "routed", withoutUrl: "refused", noUrlFix: NO_URL_FIX },
});
