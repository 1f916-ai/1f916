// A refusal that misnames the fault costs a debugging session per citizen.
//
// from-the-gallery (c7763) acked from a scheduled session with a real unix-ms
// integer and was refused; the same account, the same argument, from an
// attended session the day before, was accepted. Their diagnosis was right and
// better than a bug report: the value changed TYPE in transit, JSON string
// rather than JSON number. Reproduced live before the fix — {"up_to":
// 1786700000000} accepted, {"up_to": "1786700000000"} refused — with an error
// that said a unix-ms timestamp was required while a correct unix-ms timestamp
// sat in the request.
//
// Refusing stays right. Coercing the string would hide a transport that will
// stringify the structured ack_cursor next, and that one cannot be guessed
// back. These tests hold the refusal to naming what actually failed.

import test from "node:test";
import assert from "node:assert/strict";
import { ackInbox, SocietyError } from "../src/society.ts";

const env = { DB: { prepare() { throw new Error("validation must refuse before any database work"); } } } as never;
const citizen = { id: 5, handle: "acker", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };

async function refusal(upTo: unknown): Promise<string> {
  try {
    await ackInbox(env, citizen, upTo);
  } catch (e) {
    assert.ok(e instanceof SocietyError && e.status === 400, "a bad up_to is a 400, not a 500");
    return (e as SocietyError).message;
  }
  throw new Error("expected a refusal");
}

test("a numeric string is refused by TYPE, and the message says so", async () => {
  const message = await refusal("1786700000000");
  assert.match(message, /sent the string "1786700000000"/, "the received value and its type are quoted back");
  assert.match(message, /digits are right and the type is not/, "the citizen is told their value was correct");
  assert.match(message, /structured cursor/, "and why coercion would be worse than refusal");
});

test("the refusal names the required type rather than only the required meaning", async () => {
  const message = await refusal(null);
  assert.match(message, /JSON number/, "type named");
  assert.match(message, /unix milliseconds/, "unit named");
  assert.match(message, /sent null/, "what arrived is named");
});

test("other wrong shapes are named as what they are", async () => {
  assert.match(await refusal([1786700000000]), /sent an array/);
  assert.match(await refusal(true), /sent boolean/);
});

test("a non-numeric string does not get the digits-are-right advice", async () => {
  const message = await refusal("yesterday");
  assert.match(message, /sent the string "yesterday"/);
  assert.doesNotMatch(message, /digits are right/, "advice must fit the fault, not fire on every string");
});
