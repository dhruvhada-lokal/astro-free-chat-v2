// v3: a real user_id with no dob yet fills it in right inside the chat — onto their OWN existing account,
// never a new disconnected one. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySubmittedDob } from "../src/lib/onboard.ts";
import type { UserInput } from "../src/engine/engine.ts";

const now = new Date("2026-09-25");
// A real, already-synced user (from sync.ts's shell-user path) whose campaign row had no valid dob yet.
const existing = (over: Partial<UserInput> = {}): UserInput => ({
  token: "abcDEF123456", user_id: "101", name: "Rohan Mehta", gender: "male",
  dob: "", tob: null, pob: "Guntur, Andhra Pradesh", language: "Hinglish",
  moon_sign: "", mahadasha: "", antardasha: "", lagna: null, planets: null,
  cohort: "rc2", chat_language: "hinglish",
  ...over,
});

test("a dob submission builds a real chart onto the SAME existing account, not a new one", () => {
  const r = applySubmittedDob(existing({ tob: "03:10" }), { dob: "2002-11-05" }, now);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.user.token, "abcDEF123456", "same token — never a new, disconnected account");
  assert.equal(r.user.user_id, "101");
  assert.equal(r.user.cohort, "rc2", "keeps their real campaign cohort, never self_serve");
  assert.equal(r.user.chat_language, "hinglish", "untouched — already chosen before this screen ever shows");
  assert.deepEqual([r.user.moon_sign, r.user.lagna, r.user.mahadasha, r.user.antardasha], ["Tula", "Kanya", "Shani", "Ketu"]);
});

test("a typed name overwrites; a blank one keeps whatever the campaign row already had", () => {
  const typed = applySubmittedDob(existing(), { name: "New Name", dob: "2002-11-05" }, now);
  assert.ok(typed.ok);
  if (typed.ok) assert.equal(typed.user.name, "New Name");
  const blank = applySubmittedDob(existing(), { name: "", dob: "2002-11-05" }, now);
  assert.ok(blank.ok);
  if (blank.ok) assert.equal(blank.user.name, "Rohan Mehta", "not clobbered by a blank form field");
});

test("dob is required and validated the same way sync.ts validates it", () => {
  assert.equal(applySubmittedDob(existing(), { dob: "" }, now).ok, false);
  const bad = applySubmittedDob(existing(), { dob: "not-a-date" }, now);
  assert.ok(!bad.ok && bad.error === "dob_invalid");
  const future = applySubmittedDob(existing(), { dob: "2099-01-01" }, now);
  assert.ok(!future.ok && future.error === "dob_invalid");
  const tooOld = applySubmittedDob(existing(), { dob: "1800-01-01" }, now);
  assert.ok(!tooOld.ok && tooOld.error === "dob_invalid");
});

test("no tob/pob already on file → Moon chart, same \"could the rashi differ\" check sync.ts does", () => {
  const r = applySubmittedDob(existing({ tob: null, pob: null }), { dob: "2002-11-05" }, now);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.user.lagna, null, "no birth time → no lagna");
    assert.ok(typeof r.user.moon_certain === "boolean" && typeof r.user.dasha_certain === "boolean");
  }
});

test("a tob/pob the campaign row already had (just dob was missing) is kept and used, unasked", () => {
  const withTob = applySubmittedDob(existing({ tob: "03:10", pob: "Guntur, Andhra Pradesh" }), { dob: "2002-11-05" }, now);
  const withoutTob = applySubmittedDob(existing({ tob: null, pob: null }), { dob: "2002-11-05" }, now);
  assert.ok(withTob.ok && withoutTob.ok);
  if (withTob.ok && withoutTob.ok) {
    assert.equal(withTob.user.lagna, "Kanya", "a real tob + matched city → a real lagna, with no form asking for either");
    assert.equal(withoutTob.user.lagna, null);
  }
});
