"use client";

import { HydrationProbe } from "./hydration_probe.js";
import type { ProbeCopy } from "./hydration_probe.js";

export default function IslandVisible({ copy }: { copy: ProbeCopy }) {
  return <HydrationProbe probe="visible" copy={copy} />;
}
