import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { cloudflareWorker } from "./index.js";
import { interpretWorker } from "./interpret.test-support.js";

describeConformance({
  adapter: cloudflareWorker(),
  interpret: interpretWorker,
  policies: ["never", "always"],
});
