/** kB, as `/proc/<pid>/status` reports every `Vm*` field. */
const KIB = 1024;

export function peakRssBytes(status: string): number | undefined {
  // Anchored, so `VmPeak` (virtual size) cannot be read in its place.
  const found = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  return found === null ? undefined : Number(found[1]) * KIB;
}
