import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { nginx } from "./index.js";
import { interpretNginx } from "./interpret.test-support.js";

describeConformance({
  adapter: nginx(),
  interpret: interpretNginx,
  policies: ["never", "always"],
});
