import { join } from "node:path";

export const HOW_TO = join(import.meta.dirname, "..", "content", "how-to", "connect-a-cms.md");

export const EXAMPLE = join(import.meta.dirname, "..", "..", "cms-example");

// Written by a build, so `connect-a-cms.build.test.ts` checks it against one.
export const REPORT = ".pagedeck/budget-report.json";
