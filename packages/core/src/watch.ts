export interface SyncWatch {
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  tick(): Promise<void>;
  onFailure(error: unknown): void;
  /** Must resolve early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export async function watchSync(watch: SyncWatch): Promise<void> {
  while (!watch.signal.aborted) {
    try {
      await watch.tick();
    } catch (error) {
      watch.onFailure(error);
    }
    // Checked again before resting, so a signal that arrived during the tick
    // stops the loop then rather than one interval later.
    if (watch.signal.aborted) return;
    await watch.sleep(watch.intervalMs, watch.signal);
  }
}

export function rest(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", wake);
      resolve();
    }, ms);
    function wake(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", wake, { once: true });
  });
}
