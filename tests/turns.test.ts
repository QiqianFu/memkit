import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptAnswered, TurnState } from "../src/turns.ts";

const CONTINUE = "Continue the current task from the existing transcript, preserving completed work.";

test("turns: the first attempt's words stay the turn's user text across retries", () => {
  const t = new TurnState();
  assert.equal(t.begin("r1", "s", "我对什么过敏？").user, "我对什么过敏？");
  // First retrieval failed (nothing remembered); the retry must retrieve again
  // with the original words, and ingest must see them too.
  const retry = t.begin("r1", "s", CONTINUE);
  assert.equal(retry.user, "我对什么过敏？");
  assert.equal(retry.block, undefined);
  assert.equal(t.userOf("r1"), "我对什么过敏？");
});

test("turns: a retrieved block is reused by later attempts of the same run only", () => {
  const t = new TurnState();
  t.begin("r1", "s", "问题");
  t.remember("r1", "<block>");
  assert.equal(t.begin("r1", "s", CONTINUE).block, "<block>");
  assert.equal(t.begin("r2", "s", "新问题").block, undefined);
});

test("turns: in-flight until the run ends; a newer run of the session is not cleared by an older one", () => {
  const t = new TurnState();
  t.begin("r1", "s", "一");
  assert.ok(t.isInFlight("s"));
  t.begin("r2", "s", "二");
  t.end("r1", "s");
  assert.ok(t.isInFlight("s"), "r2 still running");
  t.end("r2", "s");
  assert.ok(!t.isInFlight("s"));
  assert.equal(t.userOf("r2"), undefined);
});

test("attemptAnswered: failed attempts report success but stopReason error", () => {
  const msgs = (stopReason: string) => [{ role: "user" }, { role: "assistant", stopReason }];
  assert.equal(attemptAnswered({ success: true, messages: msgs("error") }), false);
  assert.equal(attemptAnswered({ success: true, messages: msgs("aborted") }), false);
  assert.equal(attemptAnswered({ success: false, messages: msgs("stop") }), false);
  assert.equal(attemptAnswered({ success: true, messages: msgs("stop") }), true);
});
