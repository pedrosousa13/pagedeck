import { redactToolOutput } from "./redact.js";

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (pending + chunk).split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) process.stdout.write(`${redactToolOutput(line)}\n`);
});
process.stdin.on("end", () => {
  process.stdout.write(redactToolOutput(pending));
});
