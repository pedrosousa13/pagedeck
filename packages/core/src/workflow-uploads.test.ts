import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

const MINIMUM_UPLOADS = 5;

const MINIMUM_HIDDEN_PATH_UPLOADS = 2;

interface Upload {
  readonly file: string;
  readonly line: number;
  readonly hiddenPaths: readonly string[];
  readonly includesHidden: boolean;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .sort()
    .map((entry) => join(WORKFLOWS, entry))
    .filter((path) => statSync(path).isFile());
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isHidden(path: string): boolean {
  const pattern = path.replace(/^!/, "").replace(/^["']|["']$/g, "");
  return pattern
    .split("/")
    .some(
      (segment) =>
        segment.startsWith(".") && segment !== "." && segment !== "..",
    );
}

function uploads(source: string, file: string): Upload[] {
  const lines = source.split("\n");
  const found: Upload[] = [];

  lines.forEach((first, start) => {
    const item = /^(\s*)-\s+/.exec(first);
    if (item === null) return;
    const dash = (item[1] ?? "").length;
    const keyColumn = item[0].length;

    let end = start + 1;
    while (end < lines.length) {
      const body = lines[end] ?? "";
      if (body.trim() !== "" && indentOf(body) <= dash) break;
      end += 1;
    }
    const step = lines.slice(start, end);

    const isUpload = step.some(
      (line, offset) =>
        /^\s*(?:-\s+)?uses:\s*actions\/upload-artifact@/.test(line) &&
        (offset === 0 || indentOf(line) === keyColumn),
    );
    if (!isUpload) return;

    const paths: string[] = [];
    let includesHidden = false;
    step.forEach((line, offset) => {
      if (/^\s*include-hidden-files:\s*["']?true["']?\s*$/.test(line)) {
        includesHidden = true;
      }

      const path = /^(\s*)path:\s*(.*)$/.exec(line);
      if (path === null) return;
      const column = (path[1] ?? "").length;
      const rest = (path[2] ?? "").trim();
      if (!/^[|>]/.test(rest)) {
        paths.push(rest);
        return;
      }
      for (const body of step.slice(offset + 1)) {
        if (body.trim() !== "" && indentOf(body) <= column) break;
        if (body.trim() !== "") paths.push(body.trim());
      }
    });

    found.push({
      file,
      line: start + 1,
      hiddenPaths: paths.filter(isHidden),
      includesHidden,
    });
  });

  return found;
}

test("every upload-artifact step that names a hidden path sets include-hidden-files", () => {
  const found = workflowFiles().flatMap((path) =>
    uploads(
      readFileSync(path, "utf8"),
      relative(REPO, path).split(sep).join("/"),
    ),
  );
  expect(found.length, uploadsReport(found.length)).toBeGreaterThanOrEqual(
    MINIMUM_UPLOADS,
  );

  const hidden = found.filter((upload) => upload.hiddenPaths.length > 0);
  expect(hidden.length, hiddenReport(hidden.length)).toBeGreaterThanOrEqual(
    MINIMUM_HIDDEN_PATH_UPLOADS,
  );

  const dropped = hidden.filter((upload) => !upload.includesHidden);
  expect(dropped, droppedReport(dropped)).toEqual([]);
});

function uploadsReport(count: number): string {
  return `Workflow uploads: the scan of "${WORKFLOWS}" read ${String(count)} actions/upload-artifact step${count === 1 ? "" : "s"} of at least ${String(MINIMUM_UPLOADS)}, so the rule below passed over too little to mean anything — uploads() has stopped recognising the shape the workflows write a step in, and that is what to fix; lower MINIMUM_UPLOADS only if upload steps were deliberately removed`;
}

function hiddenReport(count: number): string {
  return `Workflow uploads: ${String(count)} upload-artifact step${count === 1 ? "" : "s"} name a hidden path, of at least ${String(MINIMUM_HIDDEN_PATH_UPLOADS)} (deploy.yml's deploy-plan upload names .deploy/staging, and deploy-landing.yml's landing-deploy upload names packages/landing/.pagedeck), so the path: reading in uploads() has stopped recognising a dot-directory and the rule below proves nothing — fix the reading; lower MINIMUM_HIDDEN_PATH_UPLOADS only if those uploads were deliberately removed`;
}

function droppedReport(dropped: readonly Upload[]): string {
  if (dropped.length === 0) return "";
  const list = dropped
    .map(
      ({ file, line, hiddenPaths }) =>
        `  ${file}:${String(line)} — ${hiddenPaths.join(", ")}`,
    )
    .join("\n");
  return `Workflow uploads: ${String(dropped.length)} actions/upload-artifact step${dropped.length === 1 ? " names" : "s name"} a hidden path without include-hidden-files: true — since upload-artifact v4.4 a file or directory whose name starts with "." is left out of the artifact unless that input is set, so the artifact silently lacks it; add include-hidden-files: true under the step's with: (#668):\n${list}`;
}
