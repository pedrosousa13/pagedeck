import { appendFileSync } from "node:fs";

const CENSUS_PATH = "PAGEDECK_PROXY_CENSUS";

export interface ProxyCensusRow {
  entry: string;
  component: string;
  renderedBy: string | null;
  prefix: string;
  refusedChildren: boolean;
}

export function recordProxyInstance(row: ProxyCensusRow): void {
  const path = process.env[CENSUS_PATH];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}
