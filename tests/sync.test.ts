import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/engine/engine.ts";
import { rowsToUsers, linkToken, normaliseDate, normaliseTime } from "../src/lib/sync.ts";
import type { SourceConfig } from "../src/lib/sync.ts";
import { findPlace } from "../src/lib/places.ts";

const L = load();
// Column names are set here (not taken from config.yaml), so the tests don't depend on the live query's naming.
const src: SourceConfig = {
  ...L.cfg.source!,
  columns: {
    user_id: "user_id", dob: "dob", tob: "tob", pob: "pob", name: "name", gender: "gender", cohort: "cohort",
    token: "link_token", holdout: "holdout", wallet_balance: "wallet_balance",
  },
  cohort_map: { lapsed_15d: "lapsed", zero_bal: "rc2" },
};
const opts = { secret: "s".repeat(20), day: "2026-09-30", now: new Date("2026-09-25") };
const row = (o: Record<string, unknown>) => ({
  user_id: "101", name: "Rohan Mehta", gender: "M", dob: "2002-11-05", tob: "03:10:00", pob: "Guntur, Andhra Pradesh",
  cohort: "lapsed_15d", link_token: "abcDEF123456", ...o,
});

test("a query row becomes a chat user with their own kundli", () => {
  const { users, report } = rowsToUsers(L.cfg, src, [row({})], opts);
  assert.equal(report.synced, 1);
  const u = users[0].user;
  assert.equal(u.token, "abcDEF123456", "the WATI link token comes from the query");
  assert.deepEqual([u.moon_sign, u.lagna, u.mahadasha, u.antardasha], ["Tula", "Kanya", "Shani", "Ketu"]);
  assert.equal(u.cohort, "lapsed");
  assert.equal(u.name, "Rohan Mehta");
  assert.equal(users[0].place, "Guntur");
  assert.equal(u.user_id, "101", "kept with the user, so chats can be joined with purchases");
  assert.ok(!u.token.includes("101"), "but never part of the chat address");
});

test("no token column → a stable, unguessable token per user and day", () => {
  const { users } = rowsToUsers(L.cfg, src, [row({ link_token: "" })], opts);
  assert.equal(users[0].user.token, linkToken(opts.secret, "101", "2026-09-30"));
  assert.notEqual(linkToken(opts.secret, "101", "2026-10-01"), users[0].user.token, "a new send day is a new chat");
});

test("unknown time or an unmatched place → Moon chart, never a guessed lagna", () => {
  const { users, report } = rowsToUsers(L.cfg, src, [
    row({ user_id: "1", tob: "" }), row({ user_id: "2", pob: "Some Village" }), row({ user_id: "3", pob: "Uttar Pradesh" }),
  ], opts);
  assert.deepEqual(users.map((u) => u.user.lagna), [null, null, null]);
  assert.deepEqual(report.places, { city: 1, state: 1, latlon: 0, none: 1 });
  assert.equal(report.charts.moon, 3);
});

test("holdout and unmapped journeys are reported, not synced; a bad dob is synced anyway, chart-less (v3)", () => {
  const { users, report } = rowsToUsers(L.cfg, src, [
    row({ user_id: "1", holdout: 1 }), row({ user_id: "2", dob: "31-02-1990" }), row({ user_id: "3", name: "" }),
    row({ user_id: "4", cohort: "new_journey" }), row({ user_id: "4", cohort: "new_journey" }), row({ user_id: "5", cohort: "zero_bal", wallet_balance: "0" }),
    row({ user_id: "6", dob: "1990-01-01" }), row({ user_id: "6", dob: "2015-06-01" }),
  ], opts);
  assert.equal(report.holdout, 1);
  assert.deepEqual(report.skipped, [], "a bad/missing dob is no longer a skip reason");
  assert.equal(report.noDob, 1);
  const noDobUser = users.find((u) => u.user_id === "2")!.user;
  assert.deepEqual([noDobUser.dob, noDobUser.moon_sign, noDobUser.lagna, noDobUser.planets], ["", "", null, null]);
  assert.equal(noDobUser.moon_certain, undefined, "not applicable without a dob yet, not false");
  assert.equal(report.noName, 1, "no name is not a reason to skip");
  assert.equal(report.severalProfiles, 1);
  assert.equal(users.filter((u) => u.user_id === "6").length, 1, "several profiles → the most complete one is used");
  assert.equal(users.filter((u) => u.user_id === "4").length, 1, "the same user listed twice with the same details: one chat");
  assert.deepEqual(report.unmappedJourneys, ["new_journey"]);
  assert.equal(users.find((u) => u.journey === "new_journey")!.user.cohort, L.cfg.default_cohort);
  assert.equal(users.find((u) => u.journey === "zero_bal")!.user.cohort, "rc2");
});

test("chat_language from the query (language_map) skips the in-chat picker; unmapped/missing leaves it unset", () => {
  const srcWithLang: SourceConfig = {
    ...src,
    columns: { ...src.columns, chat_language: "chat_language" },
    language_map: { Hindi: "hinglish", Tamil: "ta", Telugu: "te", Malayalam: "ml" },
  };
  const { users } = rowsToUsers(L.cfg, srcWithLang, [
    row({ user_id: "1", chat_language: "Hindi" }),
    row({ user_id: "2", chat_language: "tamil" }), // case-insensitive
    row({ user_id: "3", chat_language: "Klingon" }), // unmapped → unset, picker shows
    row({ user_id: "4", chat_language: "" }), // blank → unset
    row({ user_id: "5" }), // column missing from this row entirely → unset
  ], opts);
  const lang = (id: string) => users.find((u) => u.user_id === id)!.user.chat_language;
  assert.equal(lang("1"), "hinglish");
  assert.equal(lang("2"), "ta");
  assert.equal(lang("3"), null);
  assert.equal(lang("4"), null);
  assert.equal(lang("5"), null);
});

test("dates, times and places in the formats databases use", () => {
  assert.equal(normaliseDate("05-11-2002"), "2002-11-05");
  assert.equal(normaliseDate("2002-11-05T00:00:00Z"), "2002-11-05");
  assert.equal(normaliseDate("2003-02-30"), null);
  assert.equal(normaliseTime("3:40 PM"), "15:40");
  assert.equal(normaliseTime("00:00:00"), "", "midnight is how many systems store 'unknown'");
  assert.equal(findPlace("bangalore")?.matched, "Bengaluru");
  assert.equal(findPlace("Kanpur Nagar, UP")?.matched, "Kanpur");
  assert.equal(findPlace("Nagpur, Maharashtra")?.precision, "city");
  assert.equal(findPlace("somewhere, MP")?.precision, "state");
});

test("Redash: refreshes the query, waits for the job, returns the rows", async () => {
  const calls: string[] = [];
  let polls = 0;
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://r.test", "")}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Key k");
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/api/queries/20605/results")) return json({ job: { id: "j1", status: 1 } });
    if (url.endsWith("/api/jobs/j1")) return json({ job: { id: "j1", status: ++polls < 2 ? 2 : 3, query_result_id: 9 } });
    if (url.endsWith("/api/query_results/9.json")) return json({ query_result: { data: { rows: [{ user_id: 1 }] } } });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const { fetchRedash } = await import("../src/lib/sync.ts");
  const rows = await fetchRedash("https://r.test/", 20605, "k", fake, 1);
  assert.deepEqual(rows, [{ user_id: 1 }]);
  assert.deepEqual(calls, ["POST /api/queries/20605/results", "GET /api/jobs/j1", "GET /api/jobs/j1", "GET /api/query_results/9.json"]);
});

test("the WATI link /u/<user_id> opens that user's latest chat, and nothing else", async () => {
  const { resolveUserLink, linkToken, linkSignature, istDay } = await import("../src/lib/sync.ts");
  const secret = "x".repeat(20);
  const now = Date.UTC(2026, 8, 30, 6);
  const synced = new Set([linkToken(secret, "4321", istDay(1, now))]); // synced yesterday
  const getUser = async (t: string) => (synced.has(t) ? {} : null);
  assert.equal(await resolveUserLink(getUser, secret, "4321", null, {}, now), linkToken(secret, "4321", istDay(1, now)));
  assert.equal(await resolveUserLink(getUser, secret, "4322", null, {}, now), null, "not synced → no chat");
  assert.equal(await resolveUserLink(getUser, secret, "43 21", null, {}, now), null, "not a user_id");
  assert.equal(await resolveUserLink(getUser, secret, "4321", null, { lookback_days: 0 }, now), null, "older than the lookback");
  assert.equal(await resolveUserLink(getUser, "", "4321", null, {}, now), null, "no secret → nothing opens");
  const signed = { require_signature: true };
  assert.equal(await resolveUserLink(getUser, secret, "4321", "wrong", signed, now), null);
  assert.ok(await resolveUserLink(getUser, secret, "4321", linkSignature(secret, "4321"), signed, now));
});

test("one free chat every N days: tapping again in the window reopens the same chat", async () => {
  const { resolveUserLink, linkToken, istDay } = await import("../src/lib/sync.ts");
  const secret = "x".repeat(20);
  const now = Date.UTC(2026, 9, 5, 6);
  const day3ago = linkToken(secret, "777", istDay(3, now)), today = linkToken(secret, "777", istDay(0, now));
  const users = new Set([day3ago, today]);       // synced 3 days ago and again today
  const sessions = new Set([day3ago]);           // opened the chat 3 days ago
  const getUser = async (t: string) => (users.has(t) ? {} : null);
  const getSession = async (t: string) => (sessions.has(t) ? {} : null);
  const every7 = { one_chat_every_days: 7 };
  assert.equal(await resolveUserLink(getUser, secret, "777", null, every7, now, getSession), day3ago, "within 7 days → the same chat");
  assert.equal(await resolveUserLink(getUser, secret, "777", null, { one_chat_every_days: 3 }, now, getSession), today, "outside a 3-day window → today's new chat");
  assert.equal(await resolveUserLink(getUser, secret, "777", null, { one_chat_every_days: 0 }, now, getSession), today, "0 = no limit");
  assert.equal(await resolveUserLink(getUser, secret, "888", null, every7, now, getSession), null, "never chatted, not synced → looked up on click");
});
