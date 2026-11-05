// Phase 5: self-serve onboarding. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSelfServeUser } from "../src/lib/onboard.ts";

const now = new Date("2026-09-25");
const valid = { name: "Rohan Mehta", gender: "male", dob: "2002-11-05", tob: "03:10", pob: "Guntur, Andhra Pradesh" };

test("a full submission builds a real chart-ready user, cohort self_serve", () => {
  const r = buildSelfServeUser(valid, now);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.user.cohort, "self_serve");
  assert.equal(r.user.user_id, null, "no Astrolokal account tied to a self-serve entry");
  assert.equal(r.user.chat_language, null, "goes through the language picker like any other first-time chat");
  assert.equal(r.user.tob_asked, false, "the form never asks for a birth time — the details card must say nothing about it, not \"not known\"");
  assert.deepEqual([r.user.moon_sign, r.user.lagna, r.user.mahadasha, r.user.antardasha], ["Tula", "Kanya", "Shani", "Ketu"]);
  assert.match(r.user.token, /^[a-f0-9]{32}$/, "opaque, unguessable, matches TOKEN_RX");
});

test("a language picked before the form (Chat.tsx) is saved straight onto the user, skipping the picker", () => {
  const r = buildSelfServeUser({ ...valid, language: "ta" }, now);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.user.chat_language, "ta");
});

test("only date of birth is required; name and place of birth are not", () => {
  const noName = buildSelfServeUser({ ...valid, name: "" });
  assert.ok(noName.ok, "a blank name still builds a chat-ready user");
  if (noName.ok) assert.equal(noName.user.name, "", "falls back the same way a real synced user with no name column does");
  assert.ok(buildSelfServeUser({ ...valid, name: "   " }).ok);
  assert.equal(buildSelfServeUser({ ...valid, dob: "" }).ok, false);
  const bad = buildSelfServeUser({ ...valid, dob: "not-a-date" });
  assert.ok(!bad.ok && bad.error === "dob_invalid");
  const future = buildSelfServeUser({ ...valid, dob: "2099-01-01" });
  assert.ok(!future.ok && future.error === "dob_invalid");
  const tooOld = buildSelfServeUser({ ...valid, dob: "1800-01-01" });
  assert.ok(!tooOld.ok && tooOld.error === "dob_invalid");
  const noPob = buildSelfServeUser({ name: valid.name, dob: valid.dob });
  assert.ok(noPob.ok, "the form itself no longer asks for a place of birth at all");
});

test("gender and time of birth are optional; a bad time is rejected, a missing one isn't", () => {
  const noGenderNoTob = buildSelfServeUser({ name: valid.name, dob: valid.dob, pob: valid.pob }, now);
  assert.ok(noGenderNoTob.ok);
  if (noGenderNoTob.ok) {
    assert.equal(noGenderNoTob.user.gender, null);
    assert.equal(noGenderNoTob.user.tob, null);
    assert.equal(noGenderNoTob.user.lagna, null, "no birth time → no lagna, Moon chart only");
  }
  const badTob = buildSelfServeUser({ ...valid, tob: "25:99" });
  assert.ok(!badTob.ok && badTob.error === "tob_invalid");
});

test("without a time of birth, place of birth changes nothing — present, absent or unmatched all give the same chart", () => {
  const withPlace = buildSelfServeUser({ name: valid.name, dob: valid.dob, pob: "Guntur, Andhra Pradesh" }, now);
  const noPlace = buildSelfServeUser({ name: valid.name, dob: valid.dob }, now);
  const badPlace = buildSelfServeUser({ name: valid.name, dob: valid.dob, pob: "Nowhereville, Atlantis" }, now);
  assert.ok(withPlace.ok && noPlace.ok && badPlace.ok);
  if (withPlace.ok && noPlace.ok && badPlace.ok) {
    assert.equal(withPlace.user.lagna, null, "no tob → no lagna regardless of place");
    for (const u of [withPlace.user, noPlace.user, badPlace.user]) assert.equal(u.lagna, null);
    const chart = (u: typeof withPlace.user) => [u.moon_sign, u.mahadasha, u.antardasha];
    assert.deepEqual(chart(withPlace.user), chart(noPlace.user), "place never affects rashi/dasha, with or without it");
    assert.deepEqual(chart(withPlace.user), chart(badPlace.user), "nor does an unmatched place change anything");
  }
});

test("two submissions for the same person get two different tokens (no account to tie them together)", () => {
  const a = buildSelfServeUser(valid, now);
  const b = buildSelfServeUser(valid, now);
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.notEqual(a.user.token, b.user.token);
});
