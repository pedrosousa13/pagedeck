import { expect, test } from "vitest";
import { coalesce } from "./publish.js";

interface Span {
  readonly start: number;
  end?: number;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

test("a request while a run is going waits for it, and every request made meanwhile folds into one more run", async () => {
  const spans: Span[] = [];
  const gates = [gate(), gate()];
  let clock = 0;
  const runs = coalesce(async () => {
    const span: Span = { start: (clock += 1) };
    spans.push(span);
    await gates[spans.length - 1]?.wait;
    span.end = clock += 1;
  });

  runs.request();
  for (let index = 0; index < 7; index += 1) runs.request();
  expect(spans).toHaveLength(1);
  gates[0]?.open();
  await Promise.resolve();
  gates[1]?.open();
  await runs.idle();

  expect(spans).toHaveLength(2);
  expect(spans[1]?.start).toBeGreaterThan(spans[0]?.end ?? Infinity);
});

test("a request after the last run finished starts a run of its own", async () => {
  let count = 0;
  const runs = coalesce(async () => {
    count += 1;
  });

  runs.request();
  await runs.idle();
  runs.request();
  await runs.idle();

  expect(count).toBe(2);
});

test("a run that fails does not stop the run waiting behind it", async () => {
  const outcomes: string[] = [];
  let calls = 0;
  const runs = coalesce(async () => {
    calls += 1;
    if (calls === 1) {
      outcomes.push("failed");
      throw new Error("sync failed");
    }
    outcomes.push("deployed");
  });

  runs.request();
  runs.request();
  await expect(runs.idle()).rejects.toThrow(AggregateError);

  expect(outcomes).toEqual(["failed", "deployed"]);
});

test("idle with nothing requested settles at once", async () => {
  await expect(coalesce(async () => undefined).idle()).resolves.toBeUndefined();
});

test("idle reports every failure since the last call, in the order the runs failed", async () => {
  let calls = 0;
  const runs = coalesce(async () => {
    calls += 1;
    throw new Error(`run ${String(calls)} failed`);
  });

  runs.request();
  runs.request();
  const failure = await runs.idle().then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
    "run 1 failed",
    "run 2 failed",
  ]);
  await expect(runs.idle()).resolves.toBeUndefined();
});
