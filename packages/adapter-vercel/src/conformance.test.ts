import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { vercel } from "./index.js";
import { interpretVercel } from "./interpret.test-support.js";

describeConformance({
  adapter: vercel(),
  interpret: interpretVercel,
  policies: ["never", "always"],
});
