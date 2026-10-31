import assert from "node:assert/strict";
import { test } from "node:test";

import { firstLogged, idTokenHeaders } from "./support.ts";

const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

const never = new Promise<never>(() => {});

// Each row starts a wait on an empty log and gives what ends it and the error it rejects with.
const ENDINGS: [string, (log: number[], abort: AbortController) => Promise<unknown>, string][] = [
  ["the call fails", () => Promise.reject(new Error("refused")), "refused"],
  [
    "the signal aborts",
    (_, abort) => {
      abort.abort(new Error("timed out"));
      return never;
    },
    "timed out",
  ],
  [
    "the call ends having logged none",
    () => Promise.resolve(),
    "the call ended having logged none",
  ],
];

for (const [name, call, message] of ENDINGS) {
  // The timeout fails a wait that polls on past its ending, which would otherwise hang the run.
  test(
    `a wait for a logged item ends when ${name}, leaving no timer`,
    { timeout: 1_000 },
    async () => {
      const before = timers();
      const log: number[] = [];
      const abort = new AbortController();
      const waiting = firstLogged(log, 0, (item) => item > 1, call(log, abort), abort.signal);
      await assert.rejects(waiting, { message });
      assert.equal(timers(), before);
    },
  );
}

// The match is logged after the wait starts, so it is found by the 100 ms poll.
test("a wait for a logged item gives the first match logged from its start on", async () => {
  const before = timers();
  const log = [5];
  const waiting = firstLogged(log, 1, (item) => item > 1, never, new AbortController().signal);
  log.push(1, 7, 9);
  assert.equal(await waiting, 7);
  assert.equal(timers(), before);
});

// Only the live run sends the header, so this pins its shape and the empty case
// the `website` target relies on.
test("an empty ID token sends no header", () => {
  assert.deepEqual(idTokenHeaders(""), {});
  assert.deepEqual(idTokenHeaders("signed"), { "X-Serverless-Authorization": "Bearer signed" });
});
