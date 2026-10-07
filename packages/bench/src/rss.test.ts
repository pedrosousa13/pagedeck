import { expect, test } from "vitest";
import { peakRssBytes } from "./rss.js";

const STATUS = `Name:\tnode
State:\tR (running)
Tgid:\t4242
VmPeak:\t 4194304 kB
VmSize:\t 4194304 kB
VmHWM:\t  918272 kB
VmRSS:\t  812340 kB
Threads:\t11
`;

test("peak resident set is read from VmHWM, the kernel's own high-water mark", () => {
  // VmHWM, not VmRSS: it is monotonic, so any sample is the true peak so far.
  expect(peakRssBytes(STATUS)).toBe(918_272 * 1024);
});

test("a status carrying VmPeak but no VmHWM is no measurement rather than VmPeak", () => {
  // VmPeak is virtual size, tens of gigabytes on Node, and two lines above VmHWM.
  expect(
    peakRssBytes("Name:\tnode\nVmPeak:\t 4194304 kB\nVmSize:\t 4194304 kB\n"),
  ).toBeUndefined();
});

test("a status with no VmHWM reads as no measurement rather than as zero", () => {
  // An exited process leaves nothing; `0` would put the smallest peak under the largest rung.
  expect(peakRssBytes("Name:\tnode\nState:\tZ (zombie)\n")).toBeUndefined();
});
