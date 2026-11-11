// Trade attempts' storage (src/attempts.ts): the record saved before the wallet is asked must be
// kept, or the integration must not sign. A store that refuses a write, a store that silently drops it, or no store at
// all (Node's default) throw AttemptNotKept; a store that fails to read leaves the guard standing, never "nothing
// pending"; the cancelled list can't lose a request either; an explicit memory store works within the process; and a
// restart after an unknown wallet answer finds the attempt in a durable store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttemptNotKept, addCancelled, loadAttempt, loadCancelled, memoryAttemptStore, removeCancelled, saveAttempt, updateCancelled } from "../src/index.ts";

const CHAIN = "0x534e5f4d41494e", ACCOUNT = "0xacc", COIN = "0xc0";
const attempt = (over = {}) => ({ chainId: CHAIN, account: ACCOUNT, coin: COIN, target: "0xcc", venue: "curve", side: "buy", amount: "1000",
  minReceive: "1", deadline: 1_800_000_000, fromBlock: 100, nonceBefore: "0x5", startedAt: 1_700_000_000_000, ...over });
const refusing = () => ({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError: the quota has been exceeded"); }, removeItem: () => {} });
const dropping = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
const unreadable = () => ({ getItem: () => { throw new Error("SecurityError: access denied"); }, setItem: () => {}, removeItem: () => {} });
/** A durable store: a map that outlives the "process" (the test keeps it across a simulated restart). */
const durable = () => { const m = new Map(); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } }; };

test("a store that refuses the write, drops it, or doesn't exist: saveAttempt throws, so nothing is signed", () => {
  assert.throws(() => saveAttempt(attempt(), refusing()), e => e instanceof AttemptNotKept && /must not be signed/.test(e.message) && /quota/i.test(e.message));
  assert.throws(() => saveAttempt(attempt(), dropping()), e => e instanceof AttemptNotKept && /didn't read back/.test(e.message));
  assert.equal(globalThis.localStorage, undefined, "Node has no browser storage");
  assert.throws(() => saveAttempt(attempt()), e => e instanceof AttemptNotKept && /no storage/.test(e.message), "the default in Node");
  assert.throws(() => saveAttempt(attempt(), null), AttemptNotKept);
});

test("a store that fails to read leaves the guard standing, never 'nothing pending'", () => {
  const guard = loadAttempt(CHAIN, ACCOUNT, COIN, unreadable());
  assert.ok(guard, "not null");
  assert.match(guard.recoveryProblem, /couldn't be read just now/);
  assert.equal(loadAttempt(CHAIN, ACCOUNT, COIN, durable()), null, "a store that answers 'none': none");
});

test("a restart after an unknown wallet answer finds the attempt in a durable store", () => {
  const store = durable();
  saveAttempt(attempt(), store);
  // ...the wallet is asked, its answer is lost, the process restarts...
  const after = loadAttempt(CHAIN, ACCOUNT, COIN, store);
  assert.equal(after?.startedAt, attempt().startedAt);
  assert.equal(after?.recoveryProblem, undefined);
});

test("memoryAttemptStore works within the process, when passed explicitly", () => {
  const store = memoryAttemptStore();
  saveAttempt(attempt(), store);
  assert.equal(loadAttempt(CHAIN, ACCOUNT, COIN, store)?.amount, "1000");
});

test("the cancelled list can't lose a request: adding throws when not kept; updating and removing are best effort", () => {
  assert.throws(() => addCancelled(attempt(), refusing()), AttemptNotKept, "the caller then keeps it the active attempt");
  assert.throws(() => addCancelled(attempt(), dropping()), AttemptNotKept);
  const store = durable();
  addCancelled(attempt(), store);
  assert.equal(loadCancelled(CHAIN, ACCOUNT, COIN, store).length, 1);
  // A store that starts refusing: updating and removing don't throw, and the request stays listed.
  const failing = { ...store, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => updateCancelled(attempt({ hash: "0xabc" }), failing));
  assert.doesNotThrow(() => removeCancelled(attempt(), failing));
  assert.equal(loadCancelled(CHAIN, ACCOUNT, COIN, store).length, 1, "still listed, still followed");
});
