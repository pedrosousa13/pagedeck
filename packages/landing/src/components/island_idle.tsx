"use client";

import { HydrationProbe } from "./hydration_probe.js";
import type { ProbeCopy } from "./hydration_probe.js";

export default function IslandIdle({ copy }: { copy: ProbeCopy }) {
  return <HydrationProbe probe="idle" copy={copy} />;
}
