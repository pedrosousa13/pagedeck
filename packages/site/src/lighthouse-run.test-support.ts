import { cpus, totalmem } from "node:os";

// Declared here: `lighthouse`'s types reach `lib.dom` (#289).
export interface LighthouseResult {
  readonly lighthouseVersion: string;
  readonly runtimeError?: { readonly code: string; readonly message: string };
  readonly environment: { readonly hostUserAgent: string; readonly benchmarkIndex?: number };
  readonly configSettings: {
    readonly formFactor: string;
    readonly throttlingMethod: string;
    readonly throttling: unknown;
  };
  readonly categories: Readonly<Record<string, { readonly score: number | null }>>;
  readonly audits: Readonly<
    Record<
      string,
      | {
          readonly details?: {
            readonly items?: readonly Readonly<Record<string, unknown>>[];
          };
        }
      | undefined
    >
  >;
}

export interface MachineConditions {
  readonly at: string;
  readonly cores: number;
  readonly totalMemoryBytes: number;
  readonly node: string;
  readonly platform: string;
}

export function machineConditions(): MachineConditions {
  return {
    at: new Date().toISOString(),
    cores: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
}

export class NoLighthouseResult extends Error {
  constructor(subject: string, url: string) {
    super(
      `${subject}: Lighthouse returned no result, so this page contributed nothing to the report — re-run, and if it repeats the page is not loading at ${url}`,
    );
    this.name = "NoLighthouseResult";
  }
}

export interface LighthouseBrowser {
  audit(url: string, subject: string): Promise<LighthouseResult>;
  close(): Promise<void>;
}

/** Imported here, not at the top: a logic test imports this module for its error class. */
export async function launchLighthouse(): Promise<LighthouseBrowser> {
  const { launch } = await import("chrome-launcher");
  const { chromium } = await import("playwright");
  const { default: lighthouse } = await import("lighthouse");
  const chrome = await launch({
    chromePath: chromium.executablePath(),
    // `--no-sandbox`: a runner's container has no user namespace to build one in.
    // `--disable-dev-shm-usage`: a container's 64 MB `/dev/shm` crashes Chromium mid-run.
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
  return {
    async audit(url, subject) {
      // Default flags, Lighthouse's mobile configuration: spec §15's criterion 5 is about
      // mobile.
      const result = await lighthouse(url, {
        port: chrome.port,
        output: "json",
        logLevel: "error",
      });
      if (result === undefined) throw new NoLighthouseResult(subject, url);
      return result.lhr as unknown as LighthouseResult;
    },
    async close() {
      await chrome.kill();
    },
  };
}
