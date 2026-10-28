import assert from "node:assert/strict";
import { test } from "node:test";

import { hasPendingSave, queuePagehideSave } from "../../web/js/autosave.js";

const design = { id: "0123456789ab", title: "Diseño", pages: [{ elements: [] }] };

for (const [pendingState, pending] of [
  ["debounce", { timerPending: true, requestsPending: 0, revision: 1, savedRevision: 0 }],
  ["request", { timerPending: false, requestsPending: 1, revision: 1, savedRevision: 0 }],
  ["failed save", { timerPending: false, requestsPending: 0, revision: 1, savedRevision: 0 }],
]) {
  test(`pagehide queues a keepalive save while a ${pendingState} is pending`, () => {
    const calls = [];
    const queued = queuePagehideSave({
      design,
      pending: hasPendingSave(pending),
      accessToken: "secret",
      fetchImpl: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
    });

    assert.equal(queued, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `/api/disenos/${design.id}`);
    assert.equal(calls[0][1].method, "PUT");
    assert.equal(calls[0][1].keepalive, true);
    assert.equal(calls[0][1].headers["X-Lienzo-Token"], "secret");
    assert.deepEqual(JSON.parse(calls[0][1].body), { diseno: design });
  });
}

test("a completed save does not queue another pagehide request", () => {
  assert.equal(hasPendingSave({
    timerPending: false,
    requestsPending: 0,
    revision: 3,
    savedRevision: 3,
  }), false);
});

test("pagehide does not queue a save when nothing is pending", () => {
  let called = false;
  assert.equal(queuePagehideSave({
    design,
    pending: false,
    accessToken: "",
    fetchImpl: () => { called = true; },
  }), false);
  assert.equal(called, false);
});

test("pagehide skips a UTF-8 body over the keepalive budget", () => {
  let called = false;
  const oversized = { ...design, title: "界".repeat(20_000) };
  assert.equal(queuePagehideSave({
    design: oversized,
    pending: true,
    accessToken: "",
    fetchImpl: () => { called = true; },
  }), false);
  assert.equal(called, false);
});

test("pagehide handles rejected keepalive requests without an unhandled rejection", async () => {
  assert.equal(queuePagehideSave({
    design,
    pending: true,
    accessToken: "",
    fetchImpl: () => Promise.reject(new Error("closed")),
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
});
