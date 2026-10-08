import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { cloudfront } from "./index.js";
import { interpretCloudFront } from "./interpret.test-support.js";

describeConformance({
  adapter: cloudfront(),
  interpret: interpretCloudFront,
  policies: ["never", "always"],
});
