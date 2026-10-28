import { realpathSync } from "node:fs";

export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
