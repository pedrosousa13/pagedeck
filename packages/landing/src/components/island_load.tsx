"use client";

import { HydrationProbe } from "./hydration_probe.js";
import type { ProbeCopy } from "./hydration_probe.js";

export default function IslandLoad({ copy }: { copy: ProbeCopy }) {
  return <HydrationProbe probe="load" copy={copy} />;
}
