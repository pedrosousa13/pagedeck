import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { netlify } from "./index.js";
import { interpretNetlify } from "./interpret.test-support.js";

describeConformance({ adapter: netlify(), interpret: interpretNetlify });
