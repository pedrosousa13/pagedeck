// Not registered itself: a `"use client"` module may be registered under one
// name only, so each strategy has a thin module that renders this.
import { useEffect, useState } from "react";

export interface ProbeCopy {
  readonly name: string;
  readonly waiting: string;
  readonly hydrated: string;
}

export function HydrationProbe({
  probe,
  copy,
}: {
  probe: "load" | "idle" | "visible" | "static";
  copy: ProbeCopy;
}) {
  const [at, setAt] = useState<string | undefined>(undefined);
  useEffect(() => {
    setAt((performance.now() / 1000).toFixed(2));
  }, []);
  return (
    <div
      className="fw-probe"
      data-probe={probe}
      data-hydrated={at === undefined ? "false" : "true"}
    >
      <p className="fw-probe__name">{copy.name}</p>
      <p className="fw-probe__state">
        {at === undefined ? copy.waiting : copy.hydrated.replace("{seconds}", at)}
      </p>
    </div>
  );
}
