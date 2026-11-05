// End-to-end tests of the server flow (chat service + file store + mock model).
// Run with `npm test`. Uses a throwaway data folder; never touches ./data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { UserInput } from "../src/engine/engine.ts";

const dir = mkdtempSync(join(tmpdir(), "free-chat-test-"));
process.env.DATA_DIR = dir;
process.env.MOCK_LLM = "1";
process.env.MOCK_LLM_DELAY_MS = "5";
process.env.DEV_FREE_SECONDS = "120";

const chat = await import("../src/lib/chat.ts");
const { getStore } = await import("../src/lib/store.ts");
const samples = parse(readFileSync("samples/users.yaml", "utf8")) as UserInput[];
const user = (token: string): UserInput => ({ ...samples[0], token });

before(async () => {
  await getStore().upsertUsers(["u_open_001", "u_send_001", "u_crisis_01", "u_close_01", "u_limit_01", "u_event_01"].map(user));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("unknown or malformed link → invalid screen", async () => {
  assert.equal((await chat.startOrResume("nobody_here")).status, "invalid");
  assert.equal((await chat.startOrResume("../../etc")).status, "invalid");
});

test("first open: details → Omkar joins → 2-line greeting (known topic: \"kaise hai aap\"); no kundli, no topic question yet; reopening resumes", async () => {
  const v = await chat.startOrResume("u_open_001");
  assert.equal(v.status, "active");
  assert.deepEqual(v.messages.map((m) => m.role), ["details", "system", "system", "ai", "ai"]);
  assert.match(v.messages[2].text, /has joined/);
  assert.equal(v.messages[4].text, "Kaise hai aap?", "last_topic (shaadi) is known: the returning greeting, not \"Aapka swagat hai\"");
  assert.equal(v.topicAsked, false, "the topic question itself is asked later (timing.topic_wait_seconds), not bundled in here");
  assert.ok(v.secondsLeft > 115 && v.secondsLeft <= 120);
  assert.equal(v.chart?.moonSign, samples[0].moon_sign);
  assert.equal(v.persona.name, "Astro Omkar");
  assert.equal(typeof v.pacing.typing_min_ms, "number", "pacing reaches the page");
  assert.equal(v.persona.avatar, "/persona/omkar.jpg");
  assert.equal(v.chart?.kundli?.basis, "lagna");
  assert.deepEqual(v.chart?.kundli?.houses[0].items, ["Asc", "Ma 19.0°"]);
  assert.equal(v.ui.cta_label, "Talk to astrologer");
  assert.match(v.ui.card_text, /Rohan ji, aapki shaadi ki sahi timing abhi batani baaki hai/, "the card names their topic (last chat: shaadi)");
  const again = await chat.startOrResume("u_open_001");
  assert.equal(again.messages.length, v.messages.length);
  assert.equal((await getStore().getSession("u_open_001"))?.messages.length, 5);
});

test("first answer = intro + kundli + chart line + reply bubble(s); later answers = 3 replies; all stored and logged", async () => {
  await chat.startOrResume("u_send_001");
  const r = await chat.sendMessage("u_send_001", "  shaadi   kab hogi?  ");
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  // The reply bubble count here depends on which MOCK_LINES entry the rotation happens to pick (1 or 2 bubbles) —
  // the structural guarantee under test is empathy → intro → kundli → chart line → the rest of the finding, not
  // an exact count (a 1-bubble mock pick is entirely consumed as the empathy opener, with nothing left after).
  assert.deepEqual(r.messages.slice(0, 4).map((m) => m.role), ["ai", "ai", "kundli", "ai"], "empathy, intro, kundli card, chart line");
  assert.ok(r.messages.length >= 4 && r.messages.slice(4).every((m) => m.role === "ai"), "then the rest of the finding, if any");
  assert.equal(r.messages[1].text, "Aapki kundli dekh raha hoon…");
  assert.match(r.messages[3].text, /ka samay chal raha hai\.$/);
  const second = await chat.sendMessage("u_send_001", "love ya arrange?");
  assert.ok(second.ok);
  assert.ok(second.messages.every((m) => m.role === "ai"), "no second kundli");
  assert.ok(second.messages.length >= 1 && second.messages.length <= 3);
  const s = await getStore().getSession("u_send_001");
  assert.equal(s?.messages.filter((m) => m.role === "user")[0].text, "shaadi kab hogi?");
  const logs = await getStore().turnLogs("u_send_001");
  assert.equal(logs.length, 2);
  assert.equal(logs[0].route, "llm");
  const empty = await chat.sendMessage("u_send_001", "   ");
  assert.equal(empty.ok, false);
});

test("the kundli card comes with the first answer once a topic is named; a bare greeting asks again instead", async () => {
  const cfg = parse(readFileSync("config/config.yaml", "utf8"));
  const opening: string = cfg.scripted.topic_hook.default;
  const sehat: string[] = cfg.guardrails.topics?.sehat ?? cfg.topics?.sehat ?? [];
  for (const w of sehat) assert.ok(!new RegExp(`\\b${w}\\b`, "i").test(opening), `the opening must not offer "${w}": a health question gets the doctor line and no kundli`);
  const named = ["shaadi", "naukri", "paisa", "pyaar", "shaadi kab hogi?"];
  await getStore().upsertUsers(named.map((_, i) => user(`u_kundli_${i}`)));
  for (const [i, text] of named.entries()) {
    await chat.startOrResume(`u_kundli_${i}`);
    const r = await chat.sendMessage(`u_kundli_${i}`, text);
    assert.ok(r.ok);
    assert.deepEqual(r.messages.slice(0, 4).map((m) => m.role), ["ai", "ai", "kundli", "ai"], `"${text}" → empathy, kundli dekh raha hoon, card, chart line`);
  }
  // No topic at all (a bare greeting, "how are you") is deterministic, not left to the model: ask the topic
  // question again instead of ever revealing the chart with nothing to go on.
  const bare = ["hi", "hello"];
  await getStore().upsertUsers(bare.map((_, i) => user(`u_bare_${i}`)));
  for (const [i, text] of bare.entries()) {
    await chat.startOrResume(`u_bare_${i}`);
    const r = await chat.sendMessage(`u_bare_${i}`, text);
    assert.ok(r.ok);
    assert.deepEqual(r.messages.map((m) => m.role), ["ai"], `"${text}" → the topic question again, no kundli`);
  }
});

test("distress → helpline, chat closed, no sales card, nothing more accepted", async () => {
  await chat.startOrResume("u_crisis_01");
  const r = await chat.sendMessage("u_crisis_01", "ab jeene ka mann nahi karta");
  assert.ok(r.ok && r.messages.map((m) => m.text).join(" ").includes("14416"));
  assert.ok(r.ok && !r.messages.some((m) => m.role === "kundli"), "no kundli in a distress reply");
  assert.equal(r.view.crisis, true);
  assert.equal(r.view.closed, true, "chat locked; the page shows no sales sheet when crisis is true");
  const after = await chat.sendMessage("u_crisis_01", "hello");
  assert.equal(after.ok, false);
});

test("the free time starts when the chat opens (clock_starts: open)", async () => {
  const opened = await chat.startOrResume("u_close_01");
  assert.equal(opened.clockStarted, true);
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok((await chat.startOrResume("u_close_01")).secondsLeft < 120, "the clock is running before any message");
});

test("a message in the last seconds gets the closing line, then the chat ends", async () => {
  process.env.DEV_FREE_SECONDS = "41"; // above pull_until (20); closing at 15 s left
  try {
    await getStore().upsertUsers([user("u_close_02")]);
    await chat.startOrResume("u_close_02");
    const first = await chat.sendMessage("u_close_02", "shaadi kab?");
    assert.ok(first.ok && first.messages.some((m) => m.role === "kundli"));
    // jump to the last seconds: move this test session's clock back
    await getStore().withSession("u_close_02", async (s) => {
      s!.clock_started_at = new Date(Date.now() - 27_000).toISOString();
      return { session: s, result: null };
    });
    const before = (await getStore().getSession("u_close_02"))!.messages.length;
    assert.equal((await getStore().getSession("u_close_02"))!.messages.length, before, "nothing arrives on its own");
    const last = await chat.sendMessage("u_close_02", "aur batao");
    assert.ok(last.ok);
    assert.deepEqual(last.messages.map((m) => m.text), ["Rohan ji, ek aur zaroori baat dikh rahi hai…"]);
    assert.equal(last.view.closed, true);
    assert.equal((await chat.sendMessage("u_close_02", "hello?")).ok, false);
  } finally {
    process.env.DEV_FREE_SECONDS = "120";
  }
});

test("opening animates once: a fresh open is 'justStarted', a later reopen is not", async () => {
  await getStore().upsertUsers([user("u_fresh_01")]);
  assert.equal((await chat.startOrResume("u_fresh_01")).justStarted, true);
  await chat.sendMessage("u_fresh_01", "namaste");
  assert.equal((await chat.startOrResume("u_fresh_01")).justStarted, false);
});

test("restart works locally and gives a brand-new chat", async () => {
  await getStore().upsertUsers([user("u_restart1")]);
  await chat.startOrResume("u_restart1");
  await chat.sendMessage("u_restart1", "namaste");
  const again = await chat.startOrResume("u_restart1", true);
  assert.ok(again.secondsLeft >= 119, "fresh clock");
  assert.equal(again.messages.filter((m) => m.role === "user").length, 0);
});

test(`a chat accepts at most ${chat.MAX_USER_MESSAGES} messages`, async () => {
  await chat.startOrResume("u_limit_01");
  for (let i = 0; i < chat.MAX_USER_MESSAGES; i++) {
    const r = await chat.sendMessage("u_limit_01", `sawal ${i}`);
    assert.equal(r.ok, true, `message ${i}`);
  }
  const over = await chat.sendMessage("u_limit_01", "ek aur");
  assert.equal(over.ok, false);
  assert.ok(!over.ok && over.error === "too_many_messages");
});

test("events: only known names; hand-off and tap are stamped once on the session", async () => {
  await chat.startOrResume("u_event_01");
  assert.equal(await chat.recordEvent("u_event_01", "made_up"), false);
  assert.equal(await chat.recordEvent("nobody_here", "cta_tapped"), false);
  assert.equal(await chat.recordEvent("u_event_01", "cta_tapped", { seconds_left: 4, nested: { x: 1 } }), true);
  const first = (await getStore().getSession("u_event_01"))?.cta_tapped_at;
  assert.ok(first);
  await chat.recordEvent("u_event_01", "cta_tapped");
  assert.equal((await getStore().getSession("u_event_01"))?.cta_tapped_at, first);
  const ev = (await getStore().events(10)).find((e) => e.name === "cta_tapped");
  assert.equal(ev?.props.nested, undefined, "non-primitive props are dropped");
  assert.ok(ev?.props.prompt_version);
});

test("the same message twice within a few seconds is treated as one (double tap / retry)", async () => {
  await getStore().upsertUsers([user("u_dup_0001")]);
  await chat.startOrResume("u_dup_0001");
  const [a, b] = await Promise.all([chat.sendMessage("u_dup_0001", "shaadi kab?"), chat.sendMessage("u_dup_0001", "shaadi kab?")]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  const s = await getStore().getSession("u_dup_0001");
  assert.equal(s?.messages.filter((m) => m.role === "user").length, 1);
  assert.equal((await chat.sendMessage("u_dup_0001", "naukri kab?")).ok, true, "a different question still goes through");
});

test("clock_starts: first_message still works if switched back in config", async () => {
  const { load } = await import("../src/engine/engine.ts");
  const L = load();
  assert.equal(L.cfg.timing.clock_starts, "open");
});

test("the card names the topic they talk about; no topic yet → the generic hook", async () => {
  await getStore().upsertUsers([{ ...user("u_card_001"), last_topic: null }]);
  const v = await chat.startOrResume("u_card_001");
  assert.match(v.ui.card_text, /aapki kundli ki sabse zaroori baat abhi batani baaki hai/, "nothing said yet → generic");
  const r = await chat.sendMessage("u_card_001", "meri naukri kab lagegi?");
  assert.ok(r.ok);
  assert.match(r.view.ui.card_text, /aapki naukri ka sahi samay abhi batana baaki hai/, "asked about naukri → naukri card");
});

test("admin can only ever reset internal test links, never a real user", async () => {
  const { isTestToken } = await import("../src/lib/store.ts");
  assert.equal(isTestToken("t_team_01"), true);
  assert.equal(isTestToken("t_demo_shaadi_01"), true);
  assert.equal(isTestToken("Xk3p9QwLm2Zt7aBc"), false, "a real pilot token");
  assert.equal(isTestToken("t_team_01; drop"), false);
  await getStore().upsertUsers([user("t_team_99"), user("Xk3p9QwLm2Zt7aBc")]);
  const tests = (await getStore().testUsers()).map((u) => u.token);
  assert.ok(tests.includes("t_team_99"));
  assert.ok(!tests.includes("Xk3p9QwLm2Zt7aBc"));
});

// Moves every message (and the clock) of a test session into the past, as if the user had been quiet.
async function quietFor(token: string, ms: number, clockMs = ms) {
  await getStore().withSession(token, async (s) => {
    for (const m of s!.messages) m.at = new Date(new Date(m.at).getTime() - ms).toISOString();
    s!.clock_started_at = new Date(new Date(s!.clock_started_at!).getTime() - clockMs).toISOString();
    return { session: s, result: null };
  });
}

test("quiet user: Omkar starts the reading himself, never faster than the idle time", async () => {
  await getStore().upsertUsers([user("u_quiet_01")]);
  await chat.startOrResume("u_quiet_01");
  const early = await chat.nudge("u_quiet_01");
  assert.equal(early.ok, false, "not quiet long enough yet");
  if (!early.ok) assert.equal(early.error, "not_quiet");
  await quietFor("u_quiet_01", 26_000);
  const r = await chat.nudge("u_quiet_01");
  assert.ok(r.ok);
  assert.deepEqual(r.messages.slice(0, 4).map((m) => m.role), ["ai", "ai", "kundli", "ai"], "no question yet → he starts with the kundli");
  assert.equal((await chat.nudge("u_quiet_01")).ok, false, "and not again straight away");
  const logs = await getStore().turnLogs("u_quiet_01");
  assert.equal(logs.at(-1)?.route, "quiet");
});

test("quiet at the end: the closing line arrives by itself, then nothing more", async () => {
  await getStore().upsertUsers([user("u_quiet_02")]);
  await chat.startOrResume("u_quiet_02");
  await chat.sendMessage("u_quiet_02", "shaadi kab?");
  await quietFor("u_quiet_02", 1_000, 106_000); // 14 s left
  const r = await chat.nudge("u_quiet_02");
  assert.ok(r.ok);
  assert.deepEqual(r.messages.map((m) => m.text), ["Rohan ji, ek aur zaroori baat dikh rahi hai…"]);
  assert.equal(r.view.closed, true);
  assert.equal((await chat.nudge("u_quiet_02")).ok, false);
});

test("quiet at the end after an open thread: the chat just closes, no second hook", async () => {
  await getStore().upsertUsers([user("u_quiet_03")]);
  await chat.startOrResume("u_quiet_03");
  await chat.sendMessage("u_quiet_03", "shaadi kab?");
  await getStore().withSession("u_quiet_03", async (s) => { s!.state.hooked = true; return { session: s, result: null }; });
  await quietFor("u_quiet_03", 1_000, 106_000);
  const r = await chat.nudge("u_quiet_03");
  assert.ok(r.ok);
  assert.equal(r.messages.length, 0);
  assert.equal(r.view.closed, true);
});

test("no chat_language yet: the picker shows instead of the chat, nothing started", async () => {
  await getStore().upsertUsers([{ ...user("u_lang_001"), chat_language: null }]);
  const v = await chat.startOrResume("u_lang_001");
  assert.equal(v.status, "choose_language");
  assert.equal(v.clockStarted, false);
  assert.deepEqual(v.messages, []);
  assert.ok(v.languageOptions?.some((o) => o.key === "hinglish"));
  assert.ok(v.languageOptions?.some((o) => o.key === "ta"));
  assert.equal(await getStore().getSession("u_lang_001"), null, "no session is created just by showing the picker");
});

test("choosing a language saves it (once) and opens the chat in it", async () => {
  await getStore().upsertUsers([{ ...user("u_lang_002"), chat_language: null }]);
  const v = await chat.chooseLanguage("u_lang_002", "ta");
  assert.equal(v.status, "active");
  assert.equal((await getStore().getUser("u_lang_002"))?.chat_language, "ta");
  assert.match(v.messages[3]?.text ?? "", /Vanakkam/, "the opening is now in Tamil");
  // choosing again (e.g. a retried request) never overwrites an already-made choice
  const again = await chat.chooseLanguage("u_lang_002", "te");
  assert.equal((await getStore().getUser("u_lang_002"))?.chat_language, "ta");
  assert.equal(again.status, "active");
});

test("an unrecognised language choice is ignored: picker shown again, nothing saved", async () => {
  await getStore().upsertUsers([{ ...user("u_lang_003"), chat_language: null }]);
  const v = await chat.chooseLanguage("u_lang_003", "klingon");
  assert.equal(v.status, "choose_language");
  assert.equal((await getStore().getUser("u_lang_003"))?.chat_language, null);
});

test("a chat that already started is never sent back through the picker, even with chat_language unset", async () => {
  await getStore().upsertUsers([{ ...user("u_lang_004"), chat_language: "hinglish" }]);
  await chat.startOrResume("u_lang_004"); // creates the session under hinglish
  await getStore().upsertUsers([{ ...user("u_lang_004"), chat_language: null }]); // simulate legacy data missing it
  const v = await chat.startOrResume("u_lang_004");
  assert.equal(v.status, "active", "an existing session is resumed, never gated behind the picker");
});

test("the user_id never reaches the browser", async () => {
  await getStore().upsertUsers([{ ...user("u_uid_001"), user_id: "424242" }]);
  const v = await chat.startOrResume("u_uid_001");
  assert.ok(!JSON.stringify(v).includes("424242"));
});
