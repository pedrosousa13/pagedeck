import { HydrationProbe } from "./hydration_probe.js";
import type { ProbeCopy } from "./hydration_probe.js";

export default function StaticProbe({ copy }: { copy: ProbeCopy }) {
  return <HydrationProbe probe="static" copy={copy} />;
}
