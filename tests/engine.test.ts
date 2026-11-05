// Run with `npm test` from the project root. Every edit to config.yaml or prompt_template.md should keep this green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  load, validateConfig, assignArm, buildContext, newSession, buildSystemPrompt,
  openingBubbles, closingBubbles, chartLine, route, guardReply, runTurn, uiText, handoffUrl, cardText, bubblesFor, forCohort, cohortOf,
  forLanguage, languageOf, say, topicPromptLine, stageFor,
} from "../src/engine/engine.ts";
import type { UserInput, Config, LLMFn } from "../src/engine/engine.ts";

const L = load();
const users = parse(readFileSync("samples/users.yaml", "utf8")) as UserInput[];
const [rafeeq, sunita] = users;
const fresh = (u: UserInput) => { const ctx = buildContext(L.cfg, u); return { ctx, st: newSession(ctx) }; };
const clone = (): Config => structuredClone(L.cfg);

// ── Config ──
test("config is valid", () => assert.deepEqual(validateConfig(L.cfg, L.template), []));

test("config catches broken edits", () => {
  const c = clone(); c.experiment.arms[0].weight = 80;
  assert.match(validateConfig(c, L.template).join(), /add up to 80, must be 100/);
  const d = clone(); d.scripted.closing[0] = "{nam} ji, aur baatein";
  assert.match(validateConfig(d, L.template).join(), /unknown \{nam\}/);
  const f = clone(); f.scripted.closing.push("Recharge karke baat karein");
  assert.match(validateConfig(f, L.template).join(), /breaks guardrail 'money'/);
  const g = clone(); g.timing.handoff_card_at_seconds_left = 30;
  assert.match(validateConfig(g, L.template).join(), /closing_at >= handoff_card_at/);
});

// ── Arms ──
test("pilot: everyone gets the same arm", () => {
  for (let i = 0; i < 1000; i++) assert.equal(assignArm(L.cfg, `u${i}`).id, "pilot");
});

const twoArms = (): Config => {
  const c = clone();
  c.experiment.arms = [
    { id: "minimal", weight: 50, insight_level: "minimal", allow: [] },
    { id: "specific", weight: 50, insight_level: "specific", allow: ["date_or_year", "relative_time"] },
  ];
  return c;
};

test("if parallel arms are ever used: stable and close to the weights", () => {
  const c = twoArms();
  assert.deepEqual(validateConfig(c, L.template), []);
  assert.equal(assignArm(c, "abc").id, assignArm(c, "abc").id);
  let minimal = 0;
  for (let i = 0; i < 10000; i++) if (assignArm(c, `u${i}`).id === "minimal") minimal++;
  assert.ok(minimal > 4700 && minimal < 5300, `minimal got ${minimal}/10000`);
});

// ── Opening & prompt ──
test("opening greets only; the topic question (predefined or generic) comes later, via topicPromptLine", () => {
  // A known topic (rafeeq: shaadi) swaps the 2nd greeting line for "kaise hai aap"; an unknown one (sunita) keeps
  // "Aapka swagat hai." Either way the opening is just 2 lines now — no topic question bundled into it.
  assert.deepEqual(openingBubbles(L.cfg, fresh(rafeeq).ctx).length, 2);
  assert.match(openingBubbles(L.cfg, fresh(rafeeq).ctx)[1], /Kaise hai aap/);
  assert.match(openingBubbles(L.cfg, fresh(sunita).ctx)[1], /Aapka swagat hai/);
  assert.match(openingBubbles(L.cfg, fresh(sunita).ctx)[0], /Sunita ji/); // lower-case name capitalised

  assert.match(topicPromptLine(L.cfg, fresh(rafeeq).ctx), /Shaadi/, "known topic → their own predefined question");
  assert.match(topicPromptLine(L.cfg, fresh(sunita).ctx), /Kis baare mein jaanna chahte hain/, "unknown topic → the generic topic_prompt");
});

test("prompt handles unknown birth time and has no unfilled placeholders", () => {
  const { ctx, st } = fresh(sunita);
  const p = buildSystemPrompt(L, ctx, st);
  assert.match(p, /Lagna: unknown\. Don't mention lagna/);
  assert.doesNotMatch(p, /\{[a-z_]+\}/);
  assert.match(p, new RegExp(L.cfg.experiment.prompt_version));
});

// ── Routing ──
test("crisis → helpline, closes chat, no sales card", async () => {
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "ab jeene ka mann nahi karta", 5, async () => "should not be called");
  assert.match(out.bubbles.join(" "), /14416/);
  assert.equal(out.showHandoff, false);
  assert.equal(st.closed, true);
});

test("'are you AI' → exact disclosure line, no model call", async () => {
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "aap AI ho kya?", 90, async () => { throw new Error("no"); });
  assert.equal(out.bubbles[0], L.cfg.persona.disclosure_line);
});

test("health question → doctor line", () => {
  const { ctx, st } = fresh(rafeeq);
  assert.equal(route(L, ctx, st, "mera operation kab hoga", 90).kind, "health");
});

test("last seconds → scripted closing, then chat is closed", () => {
  const { ctx, st } = fresh(rafeeq);
  assert.equal(route(L, ctx, st, "aur batao", 12).kind, "closing");
  assert.equal(route(L, ctx, st, "hello?", 8).kind, "closed");
});

test("topic switches mid-chat", () => {
  const { ctx, st } = fresh(sunita);
  route(L, ctx, st, "beta ki naukri kab lagegi", 90);
  assert.equal(st.currentTopic, "naukri");
});

// ── Reply guard ──
const g = (raw: string, u = rafeeq) => { const { ctx, st } = fresh(u); return guardReply(L, ctx, st, raw); };

test("clean reply passes", () => {
  const r = g("Shaadi ka yog achha hai || Par ek graha ka prabhav hai");
  assert.equal(r.bubbles.length, 2); assert.deepEqual(r.flags, []);
});

test("guard lets Omkar echo the user's past, and joins a bubble cut mid-sentence", () => {
  assert.deepEqual(g("Itni mehnat, 2 saal se lage hain.").bubbles, ["Itni mehnat, 2 saal se lage hain."]);
  assert.deepEqual(g("Aap mehnati hain, par||Shani rok raha hai.").bubbles, ["Aap mehnati hain, par Shani rok raha hai."]);
  assert.equal(g("Yog tay hai.").bubbles.length, 0);
  for (const ok of ["Shani ki mahadasha chal rahi hai.", "Ketu ka antardasha hai.", "Shani dasha mein sabr chahiye.", "Rashi Tula, dasha Shani ki."])
    assert.equal(g(ok).bubbles.length, 1, `their own dasha is fine: ${ok}`);
});

test("guard drops what the AI must never say", () => {
  const cases: [string, string][] = [
    ["Shaadi 2027 mein hogi", "date_or_year"],
    ["Pukhraj pehniye, sab theek hoga", "remedy"],
    ["Agle saal shaadi ke yog hain", "relative_time"],
    ["2 mahine mein naukri lagegi", "relative_time"],
    ["Recharge karke pandit ji se baat karein", "money"],
    ["Main ek AI hoon", "ai_mention"],
    ["Aap par kisi ki nazar hai", "fear"],
    ["Shaadi pakka hogi", "guarantee"],
    ["Shaadi pakki hogi", "guarantee"],
    ["Main aapki celestial blueprint dekh raha hoon", "filler"],
    ["Aapki rashi Meen hai", "wrong_rashi"],
    ["Abhi Rahu ki mahadasha chal rahi hai", "wrong_dasha"],
    ["Surya dasha se naye avsar milenge", "wrong_dasha"],
    ["Rahu ka antardasha chal raha hai", "wrong_dasha"],
    ["Ketu ki mahadasha hai", "wrong_dasha"],
    ["Shani aur Ketu ka asar chal raha hai", "stacked_terms"],
    ["Shani ki mahadasha mein Ketu ki antardasha chal rahi hai", "stacked_terms"],
  ];
  for (const [text, reason] of cases) {
    const r = g(text);
    assert.equal(r.bubbles.length, 0, `should drop: ${text}`);
    assert.ok(r.flags.includes(`dropped:${reason}`), `${text} → ${r.flags}`);
  }
});

test("an arm's allow list is narrow: specific may give a time window, never a remedy", () => {
  const LL = { ...L, cfg: twoArms() };
  const pick = (id: string) => { for (let i = 0; ; i++) if (assignArm(LL.cfg, `x${i}`).id === id) return { ...rafeeq, token: `x${i}` }; };
  const guard = (raw: string, u: UserInput) => { const ctx = buildContext(LL.cfg, u); return guardReply(LL, ctx, newSession(ctx), raw); };
  const line = "Shaadi ka yog 2027 ki pehli chhamahi mein hai";
  assert.equal(guard(line, pick("specific")).bubbles.length, 1);
  assert.equal(guard(line, pick("minimal")).bubbles.length, 0);
  assert.equal(guard("Pukhraj pehniye", pick("specific")).bubbles.length, 0);
});

test("guard does not over-block normal Hinglish", () => {
  for (const ok of ["Kya hai aapka sawal", "Shani ki dasha dhyaan dene layak hai", "Aapki Chandra rashi Tula hai", "Paisa aane ke sanket hain"])
    assert.equal(g(ok).bubbles.length, 1, ok);
});

test("word length: clean up to max_words_per_bubble, flagged past that, flagged differently past " +
  "long_bubble_words — but never dropped, so nothing the model writes is silently lost", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const max = L.cfg.style.max_words_per_bubble; // 12
  const longWords = L.cfg.pacing.long_bubble_words; // 18
  const clean = g(words(max));
  assert.deepEqual(clean.bubbles, [words(max)]);
  assert.ok(!clean.flags.includes("long_bubble") && !clean.flags.includes("very_long_bubble"));
  const flagged = g(words(longWords - 1)); // 17: kept, flagged, normal pacing
  assert.deepEqual(flagged.bubbles, [words(longWords - 1)]);
  assert.ok(flagged.flags.includes("long_bubble") && !flagged.flags.includes("very_long_bubble"));
  const verylong = g(words(longWords)); // 18: still kept — the client paces this slower, never drops it
  assert.deepEqual(verylong.bubbles, [words(longWords)]);
  assert.ok(verylong.flags.includes("very_long_bubble") && !verylong.flags.includes("long_bubble"));
});

test("guard enforces bubble count and question budget", () => {
  const r = g("Ek || Do || Teen || Char");
  assert.equal(r.bubbles.length, 3); assert.ok(r.flags.includes("trimmed_extra_bubbles"));
  const { ctx, st } = fresh(rafeeq);
  assert.equal(guardReply(L, ctx, st, "Ek || Do || Teen", 1).bubbles.length, 1, "per-turn limit (first answer)");
  const LL = { ...L, cfg: clone() }; LL.cfg.style.question_budget = 1;
  const c = buildContext(LL.cfg, rafeeq);
  const q = guardReply(LL, c, newSession(c), "Aap kya jaanna chahte hain? || Shaadi ya naukri?");
  assert.equal(q.questions, 1); assert.ok(q.flags.includes("dropped:question_over_budget"));
});

// ── Full turn ──
const slow: LLMFn = () => new Promise((r) => { setTimeout(() => r("late"), 10_000).unref(); });

test("timeout → fallback line", async () => {
  const c = clone(); c.timing.llm_timeout_ms = 50;
  const LL = { ...L, cfg: c };
  // A fresh session's first message(s) are stage "gather" (see below for that one's own fallback) — force
  // "answer" instead (the clarify budget already used up) so this tests the ordinary fallback_reply path.
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(LL, ctx, { ...st, clarifyRounds: 2 }, "shaadi kab hogi", 90, slow);
  assert.equal(out.bubbles[0], L.cfg.scripted.fallback_reply);
  assert.ok(out.log.flags.includes("llm_timeout"));
});

test("a repeatedly failing \"answer\" call never loops forever — the bug: st.answered was never set on fallback, " +
  "so stageFor() kept forcing \"answer\" again every turn, sending the exact same fallback_reply line forever", async () => {
  const c = clone(); c.timing.llm_timeout_ms = 50;
  const LL = { ...L, cfg: c };
  const { ctx, st } = fresh(rafeeq);
  st.clarifyRounds = 1; st.chartShown = true; // as if gather's one round is already used and the kundli already shown
  assert.equal(stageFor(LL, st, 90), "answer", "about to attempt stage \"answer\"");
  const out = await runTurn(LL, ctx, st, "shaadi kab hogi", 90, slow);
  assert.equal(out.bubbles[0], L.cfg.scripted.fallback_reply);
  assert.equal(st.answered, true, "a failed \"answer\" must still move the conversation forward");
  assert.notEqual(stageFor(LL, st, 90), "answer", "the next turn must not retry \"answer\" again — that was the loop");
});

test("the generic fallback never repeats itself: a second failure (in a different stage) swaps to fallback_reply_alt", async () => {
  const c = clone(); c.timing.llm_timeout_ms = 50;
  const LL = { ...L, cfg: c };
  const { ctx, st } = fresh(rafeeq);
  st.chartShown = true; st.answered = true; // stage "engage" from here
  const previous = [L.cfg.scripted.fallback_reply];
  const out = await runTurn(LL, ctx, st, "accha", 90, slow, previous.map((text) => ({ role: "ai" as const, text })));
  assert.equal(out.bubbles[0], L.cfg.scripted.fallback_reply_alt, "the primary line was already said this chat");
});

test("time spent waiting on the model (success or timeout) is tracked so it can be refunded to the user's clock", async () => {
  // secondsLeft() (src/lib/chat.ts) subtracts st.llmWaitMs from elapsed wall-clock time — a slow or failing model
  // call must never silently drain the free chat's countdown. This only checks the bookkeeping generate() does;
  // the refund itself is exercised in chat.test.ts.
  const c = clone(); c.timing.llm_timeout_ms = 50;
  const LL = { ...L, cfg: c };
  const { ctx, st } = fresh(rafeeq);
  assert.equal(st.llmWaitMs ?? 0, 0);
  await runTurn(LL, ctx, st, "shaadi kab hogi", 90, slow);
  assert.ok((st.llmWaitMs ?? 0) >= 50, "at least the configured timeout was waited on");
  assert.ok((st.llmWaitMs ?? 0) < 10_000, "never the full 10s the mock llm actually takes to resolve");
});

test("stage \"gather\" that times out or fails never reveals the kundli with a generic line — it asks the topic question again", async () => {
  const c = clone(); c.timing.llm_timeout_ms = 50;
  const LL = { ...L, cfg: c };
  const { ctx, st } = fresh(rafeeq); // fresh: first message → stage "gather"
  const out = await runTurn(LL, ctx, st, "shaadi kab hogi", 90, slow);
  assert.equal(out.bubbles[0], "Shaadi ko lekar abhi kya dikkat aa rahi hai?",
    "a real clarifying follow-up (topic_followup), not topic_hook's yes/no topic confirmation (last_topic: shaadi)");
  assert.equal(out.log.clarifying, true, "so sendMessage() knows not to reveal the kundli for this turn");
  assert.equal(st.clarifyRounds, 1, "gather's one allowed round (MAX_CLARIFY_ROUNDS = 1) is now used");
  assert.equal(st.chartShown, undefined, "never set — the card hasn't actually gone out yet");
  // The one clarify round is used: the very next reply is forced into "answer" (a real finding), never a second
  // gather round — this is what stops the model re-asking its own gather question turn after turn.
  assert.equal(stageFor(LL, st, 90), "answer");
});

test("bad reply → one retry → good reply is used", async () => {
  let calls = 0;
  const llm: LLMFn = async () => (++calls === 1 ? "Shaadi 2027 mein pakka hogi" : "Shaadi ka yog achha hai || Ek graha ka prabhav hai");
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "shaadi kab hogi", 90, llm);
  assert.equal(calls, 2); assert.equal(out.log.retried, true); assert.equal(out.bubbles.length, 2);
});

test("model error → fallback, and the log has everything the analysis needs", async () => {
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "shaadi kab hogi", 90, async () => { throw new Error("500"); });
  assert.equal(out.log.used_fallback, true);
  for (const k of ["arm", "prompt_version", "config_hash", "route", "flags", "latency_ms", "show_handoff"])
    assert.ok(k in out.log, k);
});

// ── Screen copy, hand-off link, closing ──
test("ui copy renders for every sample user (no unfilled placeholders)", () => {
  for (const u of users) {
    const ui = uiText(L.cfg, fresh(u).ctx);
    for (const [k, v] of Object.entries(ui)) assert.doesNotMatch(v, /\{[a-z_]+\}/, `${u.name}: ui.${k}`);
  }
  assert.match(uiText(L.cfg, fresh(sunita).ctx).details_message, /Birth time not known/);
  assert.match(uiText(L.cfg, fresh(rafeeq).ctx).details_message, /5 Nov 2002/);
});

test("hand-off link: app links go out exactly as given; web links carry token + version; never personal data", () => {
  const appLink = clone(); appLink.handoff.deeplink_no_balance = "astrolokal://Home";
  assert.equal(handoffUrl({ ...L, cfg: appLink }, rafeeq.token), "astrolokal://Home", "a non-https app link stays exactly that");
  // The main config's own deeplink is an https OneLink URL now (deferred deep link) — https links always carry the UTM.
  const mainUrl = handoffUrl(L, rafeeq.token);
  assert.ok(mainUrl.startsWith(`${L.cfg.handoff.deeplink_no_balance}?`) && mainUrl.includes(`utm_term=${rafeeq.token}`),
    "the OneLink deeplink gets the UTM appended, same as any other https link");
  const c = clone(); c.handoff.deeplink_no_balance = "https://x.test/app";
  const url = handoffUrl({ ...L, cfg: c }, rafeeq.token);
  assert.match(url, /^https:\/\/x\.test\/app\?.*utm_term=t_demo_shaadi_01/);
  assert.doesNotMatch(url, /Rohan|2002|Guntur/);
});

test("an app link needs an https fallback for users without the app", () => {
  // The main config's own deeplinks are https (OneLink) now, so this rule needs a custom-scheme deeplink forced
  // in to exercise it — an https deeplink needs no fallback_url at all (OneLink handles its own store-redirect).
  const c = clone(); c.handoff.deeplink_with_balance = "astrolokal://Home"; delete c.handoff.fallback_url;
  assert.match(validateConfig(c, L.template).join(), /fallback_url/);
  const bad = clone(); bad.handoff.deeplink_no_balance = "Home";
  assert.match(validateConfig(bad, L.template).join(), /app link/);
});


test("model gets recent history plus the new message", async () => {
  let seen = 0;
  const llm: LLMFn = async ({ messages }) => { seen = messages.length; return "Achha sanket hai"; };
  const { ctx, st } = fresh(rafeeq);
  const history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "ai" : "user") as "ai" | "user", text: `m${i}` }));
  await runTurn(L, ctx, st, "shaadi kab hogi", 90, llm, history);
  assert.equal(seen, 9);
});

// ── Persona photo ──
test("persona.avatar_url: accepts a public file, an https link or nothing; rejects anything else", () => {
  for (const ok of ["", "/persona/omkar.jpg", "https://cdn.astrolokal.com/omkar.webp"]) {
    const c = clone(); c.persona.avatar_url = ok;
    assert.deepEqual(validateConfig(c, L.template), [], ok);
  }
  for (const bad of ["omkar.jpg", "http://insecure.com/a.jpg", "/persona/omkar.gif", "javascript:alert(1)"]) {
    const c = clone(); c.persona.avatar_url = bad;
    assert.match(validateConfig(c, L.template).join(), /avatar_url/, bad);
  }
});

test("persona.avatar_url pointing to a missing file fails the config check", async () => {
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "fc-cfg-"));
  try {
    mkdirSync(join(root, "config"));
    cpSync("config/prompt_template.md", join(root, "config", "prompt_template.md"));
    const yaml = readFileSync("config/config.yaml", "utf8").replace('avatar_url: "/persona/omkar.jpg"', 'avatar_url: "/persona/nobody.jpg"');
    writeFileSync(join(root, "config", "config.yaml"), yaml);
    assert.throws(() => load(join(root, "config")), /public\/persona\/nobody\.jpg does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Gemini message shape ──
test("messages sent to Gemini start with the user and alternate turns", async () => {
  const { toGeminiMessages } = await import("../src/lib/llm.ts");
  const out = toGeminiMessages([
    { role: "ai", text: "Namaste" }, { role: "ai", text: "Tula rashi" },
    { role: "user", text: "shaadi?" }, { role: "user", text: "kab?" }, { role: "ai", text: "Yog hai" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(out[1].content, "Namaste\nTula rashi");
  assert.equal(out[2].content, "shaadi?\nkab?");
});

test("model settings are validated", () => {
  const c = clone(); c.model.name = "gpt-4o";
  assert.match(validateConfig(c, L.template).join(), /Gemini model id/);
  const d = clone(); d.model.thinking = "max";
  assert.match(validateConfig(d, L.template).join(), /model.thinking/);
});

test("Omkar never repeats a line he already said (case and punctuation ignored)", () => {
  const { ctx, st } = fresh(rafeeq);
  const r = guardReply(L, ctx, st, "Prem vivah ke yog hain || Shani ka asar hai", 3, ["prem vivah ke yog hain."]);
  assert.deepEqual(r.bubbles, ["Shani ka asar hai"]);
  assert.ok(r.flags.includes("dropped:repeat"));
});

test("each reply has a job: gather context first, then answer, then engage, then one open thread", () => {
  const { ctx, st } = fresh(rafeeq);
  assert.match(buildSystemPrompt(L, ctx, st, 2, 110), /very first message and you don't yet know enough/);
  const shown = { ...st, chartShown: true, answered: true };
  assert.match(buildSystemPrompt(L, ctx, { ...shown, engageTurns: 1 }, 3, 90), /ONE short question/);
  assert.match(buildSystemPrompt(L, ctx, shown, 3, 15), /ONE open thread/);
  assert.match(buildSystemPrompt(L, ctx, st, 2, 90, true), /gone quiet[\s\S]*Carry on by yourself/);
  assert.match(buildSystemPrompt(L, ctx, { ...shown, answered: false }, 3, 90), /Give the real answer now/,
    "if Omkar opened the chart himself, their first question still gets the real answer (stage \"answer\", not \"gather\" again — chartShown is already true)");
  assert.match(buildSystemPrompt(L, ctx, { ...st, clarifyRounds: 1 }, 2, 110), /Give the real answer now/,
    "gather's one allowed round (MAX_CLARIFY_ROUNDS = 1) is already used: forced into a real answer, never a second gather round");
});

test("\"engage\" runs a fixed, unconditional ladder by turn count — turn 1 bridge+question together, turn 2 " +
  "cliffhanger, turn 3 stall, every chat, regardless of what the user says — then plain reacting afterward", () => {
  const { ctx, st } = fresh(rafeeq);
  const shown = { ...st, chartShown: true, answered: true };
  const BRIDGE = /very first reply after the kundli reveal ended/;
  // "Keep them talking" alone also appears in the shared template's FLOW step 4 on every single prompt — this
  // longer phrase is unique to reply_instructions.engage itself.
  const BASE_ENGAGE = /Keep them talking and enjoying it/;
  const p1 = buildSystemPrompt(L, ctx, { ...shown, engageTurns: 1 }, 3, 90);
  assert.match(p1, BRIDGE, "engageTurns is already incremented for THIS turn by route()/runNudge() before buildSystemPrompt runs");
  assert.match(p1, /ONE short question/, "turn 1 also carries the one real question — it fires together with the " +
    "bridge, never waiting on a separate user message");
  assert.doesNotMatch(p1, BASE_ENGAGE,
    "turn 1 is ONLY the bridge+question — the base engage reacting+insight instruction must not be layered underneath it");
  const p2 = buildSystemPrompt(L, ctx, { ...shown, engageTurns: 2 }, 3, 90);
  assert.match(p2, /ke peeche ek wajah hai/, "turn 2 is always the cliffhanger");
  assert.doesNotMatch(p2, BASE_ENGAGE, "turn 2 is ONLY the cliffhanger, nothing from base engage");
  const p3 = buildSystemPrompt(L, ctx, { ...shown, engageTurns: 3 }, 3, 90);
  assert.match(p3, /"agar" or "magar"/, "turn 3 is always the stalling move");
  assert.doesNotMatch(p3, BASE_ENGAGE, "turn 3 is ONLY the stall, nothing from base engage");
  for (const engageTurns of [2, 3, 4]) {
    assert.doesNotMatch(buildSystemPrompt(L, ctx, { ...shown, engageTurns }, 3, 90), BRIDGE,
      `turn ${engageTurns}: the bridge line never repeats past turn 1`);
  }
  const p4 = buildSystemPrompt(L, ctx, { ...shown, engageTurns: 4 }, 3, 90);
  assert.doesNotMatch(p4, /ONE short question|ke peeche ek wajah hai|"agar" or "magar"/,
    "past the fixed sequence (turn 4+), the ladder is gone");
  assert.match(p4, BASE_ENGAGE, "turn 4+: base engage reacting+insight comes back once the ladder is done");
});

test("the \"engage\" ladder's turn number is logged for the client to pace each turn (TurnLog.ladder_turn)", async () => {
  const { ctx, st } = fresh(rafeeq);
  const shown = { ...st, chartShown: true, answered: true };
  const llm: LLMFn = async () => "Chaliye, isko ek baar aur dekh leta hoon. || Kya aap thoda aur bata sakte hain?";
  const out1 = await runTurn(L, ctx, shown, "sab theek toh hoga na?", 90, llm);
  assert.equal(out1.log.ladder_turn, 1, "the first engage turn — bridge and question, together");
  const out2 = await runTurn(L, ctx, shown, "accha", 90, llm);
  assert.equal(out2.log.ladder_turn, 2, "the second engage turn — always the cliffhanger now, never the bridge again");
});

test("engage carries a doubt-creating line every 3rd turn once the fixed ladder (turns 1-3) is done, counted by " +
  "turn not success", () => {
  // engageTurns is incremented unconditionally in route()/runNudge(), before the model is even called — a failed
  // or guard-rejected reply still advances the count, so the rhythm can't silently drift or never fire.
  const { ctx, st } = fresh(rafeeq);
  const shown = { ...st, chartShown: true, answered: true };
  const expectDoubt = [false, false, false, false, false, true, false, false, true]; // engageTurns 1..9 — 1-3 are
  // the fixed ladder (never doubt), then every 3rd turn after that (6, 9, …)
  for (const [i, doubt] of expectDoubt.entries()) {
    const engageTurns = i + 1;
    const p = buildSystemPrompt(L, ctx, { ...shown, engageTurns }, 3, 90);
    if (doubt) assert.match(p, /doubt-creating line/, `engageTurns=${engageTurns} should carry the doubt instruction`);
    else assert.doesNotMatch(p, /doubt-creating line/, `engageTurns=${engageTurns} should not`);
  }
  // Not during "answer" or "hook", even if engageTurns happens to land on a "doubt" value.
  assert.doesNotMatch(buildSystemPrompt(L, ctx, { ...shown, answered: false, engageTurns: 6 }, 3, 90), /doubt-creating line/);
  assert.doesNotMatch(buildSystemPrompt(L, ctx, { ...shown, engageTurns: 6 }, 3, 15), /doubt-creating line/, "stage \"hook\" has its own open-thread behaviour already");
});

test("the doubt-rhythm counter advances even when the model call fails (the bug: a fallback used to silently skip it)", async () => {
  const { ctx, st } = fresh(rafeeq);
  const shown = { ...st, chartShown: true, answered: true };
  route(L, ctx, shown, "accha", 90); // stage "engage" — just deciding the route must count it, model not even called yet
  assert.equal(shown.engageTurns, 1);
  route(L, ctx, shown, "aur kuch", 90);
  assert.equal(shown.engageTurns, 2, "counts every engage turn, success or not — this is what makes the 3rd one reliable");
});

test("once a topic is named, a later reply that doesn't repeat the word isn't treated as no-info-at-all", () => {
  // Regression: "Naukri" (names a topic) → "Naukri mein kya dikkat hai?" (gather's own clarify) → "Lag nahi rahi"
  // (answers it, but mentions no topic keyword by itself) used to wrongly re-trigger the deterministic
  // clarify_topic route (the generic "Kis baare mein jaanna chahte hain aap?"), resetting the conversation.
  const { ctx, st } = fresh(sunita); // last_topic: null — unknown topic going in
  const r1 = route(L, ctx, st, "Naukri", 90);
  assert.equal(r1.kind, "llm", "a named topic always goes to the model (gather), never the deterministic route");
  assert.equal(st.topicNamedByUser, true);
  const r2 = route(L, ctx, st, "Lag nahi rahi", 90);
  assert.equal(r2.kind, "llm", "no topic keyword in THIS message, but one was already named — must not reset to clarify_topic");
});

test("a bare \"hi\" first doesn't eat into stage \"gather\"'s own clarify budget", () => {
  // Regression: "hi" (deterministic clarify_topic) used to share the same counter as stage "gather"'s own
  // clarifying questions. So "hi" → "naukri" (1 gather clarify) → "lag nahi rahi" had already exhausted the
  // 2-round budget from "hi" alone, forcing stage "answer" before there was any real context — and if that
  // forced answer failed, it fell back to a generic line with the kundli already attached.
  const { ctx, st } = fresh(sunita);
  const hi = route(L, ctx, st, "hi", 90);
  assert.equal(hi.kind, "clarify_topic");
  assert.equal(st.noTopicRounds, 1);
  assert.equal(st.clarifyRounds ?? 0, 0, "the deterministic no-topic re-ask must never touch gather's own budget");
  const named = route(L, ctx, st, "naukri", 90);
  assert.equal(named.kind, "llm");
  assert.equal(stageFor(L, st, 90), "gather", "clarifyRounds is untouched by \"hi\", so gather's full budget is still available");
});

test("2–3 bubbles like a person: short first answer, full early replies, then it varies", () => {
  const st = { ...fresh(rafeeq).st };
  assert.equal(bubblesFor(L, st, "t"), L.cfg.style.first_answer_bubbles);
  const counts: number[] = [];
  for (let turns = 1; turns <= 12; turns++) counts.push(bubblesFor(L, { ...st, chartShown: true, turns }, "t_x"));
  assert.deepEqual(counts.slice(0, L.cfg.style.early_replies), Array(L.cfg.style.early_replies).fill(L.cfg.style.max_bubbles));
  const later = counts.slice(L.cfg.style.early_replies);
  assert.ok(later.every((n) => L.cfg.style.later_bubbles.includes(n)));
  assert.ok(new Set(later).size > 1, "later replies vary");
});

test("the AI never points away from the chat (pandit ji, next time)", () => {
  assert.equal(g("Shaadi ka faisla pandit ji batayenge.").bubbles.length, 0);
  assert.equal(g("Baaki baad mein bataunga.").bubbles.length, 0);
});

test("the hand-off card names their topic; no topic or health → the generic hook", () => {
  assert.match(cardText(L.cfg, fresh(rafeeq).ctx, "shaadi"), /Rohan ji, aapki shaadi ki sahi timing abhi batani baaki hai/);
  assert.match(cardText(L.cfg, fresh(rafeeq).ctx, "naukri"), /Rohan ji, aapki naukri ka sahi samay abhi batana baaki hai/);
  for (const t of [null, "sehat"]) assert.match(cardText(L.cfg, fresh(rafeeq).ctx, t), /Rohan ji, aapki kundli ki sabse zaroori baat abhi batani baaki hai/);
  const t = clone(); t.card_text_by_topic = { shaadi: "{name} ji, shaadi" };
  assert.equal(cardText(t, fresh(rafeeq).ctx, "shaadi"), "Rohan ji, shaadi");
  const c = clone(); c.card_text_by_topic = { cricket: "x" };
  assert.match(validateConfig(c, L.template).join(), /not a topic/);
});

test("message pacing is validated", () => {
  const a = clone(); a.pacing.typing_min_ms = 2000; a.pacing.typing_max_ms = 1000;
  assert.match(validateConfig(a, L.template).join(), /typing_min_ms must not exceed/);
  const b = clone(); b.pacing.system_note_ms = -5;
  assert.match(validateConfig(b, L.template).join(), /pacing.system_note_ms must be 0–5000/);
});

test("cohorts: each changes only what's different; the CTA link follows the wallet balance", () => {
  const withOffer = clone(); withOffer.cohorts = { ...withOffer.cohorts, rc2: { ui: { card_offer: "Bucket offer" } } };
  const LO = { ...L, cfg: withOffer };
  const low = forCohort(LO, "rc2");
  assert.equal(low.cfg.ui.card_offer, "Bucket offer");
  assert.equal(low.cfg.ui.cta_label, L.cfg.ui.cta_label, "untouched keys come from the main config");
  assert.equal(forCohort(L, "lapsed"), L, "an empty cohort is the main config");
  assert.equal(cohortOf(L.cfg, { cohort: "nonsense" }), L.cfg.default_cohort);
  const c = clone(); c.handoff.deeplink_with_balance = "https://x.test/chat"; c.handoff.deeplink_no_balance = "https://x.test/recharge";
  const LL = { ...L, cfg: c };
  assert.match(handoffUrl(LL, "tok", { wallet_balance: 50, cohort: "rc2" }), /^https:\/\/x\.test\/chat\?.*cohort=rc2.*bal=yes/);
  assert.match(handoffUrl(LL, "tok", { wallet_balance: 0 }), /^https:\/\/x\.test\/recharge\?.*cohort=lapsed.*bal=no/);
});

test("languages: an empty language is the main config; unknown values fall back to default_language", () => {
  assert.equal(forLanguage(L, "hinglish"), L, "an empty language override is the main config");
  assert.equal(languageOf(L.cfg, "nonsense"), L.cfg.default_language);
  assert.equal(languageOf(L.cfg, null), L.cfg.default_language);
  assert.equal(languageOf(L.cfg, "HINGLISH"), "hinglish", "matched case-insensitively");
});

test("languages: scripted text and UI copy replace, like a cohort would", () => {
  const c = clone();
  c.languages = { ...c.languages, ta: { ui: { cta_label: "பேசுங்கள்" }, scripted: { ...c.scripted, opening: ["Vanakkam {name}"] } } };
  const LT = forLanguage({ ...L, cfg: c }, "ta");
  assert.equal(LT.cfg.ui.cta_label, "பேசுங்கள்");
  assert.equal(LT.cfg.ui.strip_cta, L.cfg.ui.strip_cta, "untouched keys still come from the main config");
  assert.equal(LT.cfg.scripted.opening[0], "Vanakkam {name}");
});

test("languages: guardrails ADD to the base set, they never replace it", () => {
  const c = clone();
  const baseBannedCount = c.guardrails.banned.length;
  const baseCrisisCount = c.guardrails.crisis.length;
  c.languages = {
    ...c.languages,
    ta: { guardrails: { banned: [{ reason: "date_or_year", pattern: "\\bவருடம்\\b" }], crisis: ["தற்கொலை"] } },
  };
  const LT = forLanguage({ ...L, cfg: c }, "ta");
  assert.equal(LT.cfg.guardrails.banned.length, baseBannedCount + 1, "base banned patterns are kept, the new one is added");
  assert.equal(LT.cfg.guardrails.crisis.length, baseCrisisCount + 1, "base crisis phrases are kept, the new one is added");
  // the original Hindi/English guardrail still applies, even under the Tamil override
  const g2 = (raw: string) => guardReply(LT, fresh(rafeeq).ctx, newSession(fresh(rafeeq).ctx), raw);
  assert.equal(g2("Yog tay hai.").bubbles.length, 0, "base guardrail (guarantee) still applies under a language override");
});

test("languages: ta/te/ml content renders cleanly for every sample user, no unfilled placeholders", () => {
  for (const lang of ["ta", "te", "ml"] as const) {
    const LT = forLanguage(L, lang);
    assert.ok(LT !== L, `${lang}: should actually override something`);
    for (const u of users) {
      const ctx = buildContext(LT.cfg, u);
      for (const b of openingBubbles(LT.cfg, ctx)) assert.doesNotMatch(b, /\{[a-z_]+\}/, `${lang} opening: ${u.name}`);
      for (const b of closingBubbles(LT.cfg, ctx)) assert.doesNotMatch(b, /\{[a-z_]+\}/, `${lang} closing: ${u.name}`);
      const ui = uiText(LT.cfg, ctx);
      for (const [k, v] of Object.entries(ui)) assert.doesNotMatch(v, /\{[a-z_]+\}/, `${lang} ui.${k}: ${u.name}`);
      for (const k of REQUIRED_UI_FOR_TEST) assert.ok(ui[k], `${lang} ui.${k} missing for ${u.name}`);
    }
    assert.deepEqual(validateConfig(LT.cfg, L.template), [], `${lang}: merged config is itself valid`);
  }
});

const REQUIRED_UI_FOR_TEST = [
  "joining", "joined", "details_message", "tob_unknown", "kundli_caption", "kundli_lagna_chart", "kundli_moon_chart",
  "moon_sign_label", "dasha_label", "day_chip", "strip_during", "strip_reveal", "time_up", "time_up_status", "card_text",
  "cta_label", "cta_subtext", "card_offer", "status_online", "status_typing", "strip_cta", "input_placeholder",
  "send_error", "ended_title", "invalid_title", "invalid_text",
];

test("languages: ta/te/ml guardrails strictly add to the base — counts grow, nothing is lost", () => {
  for (const lang of ["ta", "te", "ml"] as const) {
    const LT = forLanguage(L, lang);
    for (const k of ["banned", "crisis", "injection", "ai_question"] as const)
      assert.ok(LT.cfg.guardrails[k].length > L.cfg.guardrails[k].length, `${lang}: guardrails.${k} should grow, not shrink or stay flat`);
    for (const b of L.cfg.guardrails.banned) assert.ok(LT.cfg.guardrails.banned.some((x) => x.reason === b.reason && x.pattern === b.pattern));
    for (const p of L.cfg.guardrails.crisis) assert.ok(LT.cfg.guardrails.crisis.includes(p));
  }
});

test("languages: base Hindi/English guardrails still catch violations under a language override (union, not swap)", () => {
  for (const lang of ["ta", "te", "ml"] as const) {
    const LT = forLanguage(L, lang);
    const guard = (raw: string) => { const ctx = buildContext(LT.cfg, rafeeq); return guardReply(LT, ctx, newSession(ctx), raw); };
    assert.equal(guard("Shaadi 2027 mein hogi").bubbles.length, 0, `${lang}: base date_or_year still applies`);
    assert.equal(guard("Pukhraj pehniye, sab theek hoga").bubbles.length, 0, `${lang}: base remedy still applies`);
    assert.equal(guard("Main ek AI hoon").bubbles.length, 0, `${lang}: base ai_mention still applies`);
  }
});

test("a broken language stops the config from loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
  try {
    mkdirSync(join(dir, "config"));
    cpSync("public", join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "config", "prompt_template.md"), L.template);
    const yaml = readFileSync("config/config.yaml", "utf8").replace("  hinglish: {}", "  hinglish: { experiment: { id: x } }");
    writeFileSync(join(dir, "config", "config.yaml"), yaml);
    assert.throws(() => load(join(dir, "config")), /languages\.hinglish cannot change "experiment"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken cohort stops the config from loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
  try {
    mkdirSync(join(dir, "config"));
    cpSync("public", join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "config", "prompt_template.md"), L.template);
    const yaml = readFileSync("config/config.yaml", "utf8").replace("  lapsed: {}", "  lapsed: { experiment: { id: x } }");
    writeFileSync(join(dir, "config", "config.yaml"), yaml);
    assert.throws(() => load(join(dir, "config")), /cohorts\.lapsed cannot change "experiment"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing data is skipped cleanly: no name, no gender, uncertain rashi/dasha", () => {
  const u = { ...rafeeq, name: "", gender: null, tob: null, moon_certain: false, dasha_certain: false };
  const { ctx, st } = fresh(u);
  assert.equal(openingBubbles(L.cfg, ctx)[0], "Namaste ji 🙏");
  assert.equal(closingBubbles(L.cfg, ctx)[0], "Ek aur zaroori baat dikh rahi hai…");
  const ui = uiText(L.cfg, ctx);
  assert.equal(ui.kundli_caption, "Your Kundli");
  assert.doesNotMatch(ui.details_message, /·\s*·|^\s*·|·\s*$/m, "no empty separators on the details card");
  assert.equal(cardText(L.cfg, ctx, null), "Aapki kundli ki sabse zaroori baat abhi batani baaki hai 👀");
  assert.equal(chartLine(L.cfg, ctx, null), L.cfg.scripted.chart_line_unsure.default, "rashi not certain, no topic → the default chart line, never dropped");
  assert.equal(chartLine(L.cfg, ctx, "naukri"), L.cfg.scripted.chart_line_unsure.naukri, "rashi not certain, topic known → the topic's own positive chart line");
  const p = buildSystemPrompt(L, ctx, st);
  assert.match(p, /Their name isn't known/);
  assert.match(p, /Their gender isn't known.*kaise.*kaisa.*kaisi/s, "no gender → told to use the neutral form, not a guessed one");
  assert.match(p, /Rashi: not certain/);
  assert.match(p, /Dasha: not certain/);
  assert.doesNotMatch(p, /Name: /);
  assert.doesNotMatch(p, /\{[a-z_]+\}/);
  assert.equal(g("Tula rashi mein prem yog hai.", u).bubbles.length, 0, "any rashi claim is dropped when it isn't certain");
  const rashiOnly = fresh({ ...rafeeq, tob: null, dasha_certain: false }).ctx;
  assert.equal(chartLine(L.cfg, rashiOnly, null), L.cfg.scripted.chart_line_unsure.default,
    "no birth time → dasha uncertain too → the generic chart line instead of naming one; the card still carries the rashi");
});

test("a name with no gender (every self-serve user): the separator before the name isn't swallowed", () => {
  // Regression: "{name} · {gender_label} · {dob_label}" with an empty gender_label used to collapse to
  // "{name}· {dob_label}" — the space right before the surviving "·" was eaten along with the empty one.
  const { ctx } = fresh({ ...rafeeq, gender: null });
  const details = uiText(L.cfg, ctx).details_message;
  assert.doesNotMatch(details, /\S·/, "a space must separate the name from the surviving separator");
  assert.doesNotMatch(details, /·\s*·|^\s*·|·\s*$/m);
});

test("say() collapses a run of empty-separator gaps to exactly one properly-spaced separator", () => {
  const tpl = "{name} · {gender_label} · {dob_label}";
  assert.equal(say(tpl, { name: "Amit", gender_label: "", dob_label: "15 Jun 1995" }), "Amit · 15 Jun 1995");
  assert.equal(say(tpl, { name: "", gender_label: "", dob_label: "15 Jun 1995" }), "15 Jun 1995");
  assert.equal(
    say(tpl, { name: "Priya", gender_label: "Female", dob_label: "14 Aug 1998" }),
    "Priya · Female · 14 Aug 1998",
    "all three present is untouched",
  );
});

test("the AI is told never to ask for birth time, birth place or gender, in every language", () => {
  // Fields the form never collects (self-serve) or the pipeline may not have (any user): the model must never
  // probe for them.
  // prompt_template.md is loaded once and shared across every language override, so one check covers all of them.
  const p = buildSystemPrompt(L, fresh(rafeeq).ctx, newSession(fresh(rafeeq).ctx));
  assert.match(p, /never ask for their birth time, birth place or gender/i);
});

test("self-serve users (tob_asked: false): the details card says nothing about birth time, not \"not known\"", () => {
  const asked = fresh({ ...rafeeq, tob: null }).ctx; // a real pipeline that DID ask, just left blank
  assert.match(uiText(L.cfg, asked).details_message, /Birth time not known/);
  const neverAsked = fresh({ ...rafeeq, tob: null, tob_asked: false }).ctx; // self-serve: never asked at all
  const ui = uiText(L.cfg, neverAsked);
  assert.doesNotMatch(ui.details_message, /Birth time not known/);
  assert.doesNotMatch(ui.details_message, /·\s*·|^\s*·|·\s*$/m, "no empty separators left behind");
  // A real birth time still shows normally regardless of tob_asked.
  const withTime = fresh({ ...rafeeq, tob_asked: false }).ctx; // rafeeq has a real tob in samples/users.yaml
  assert.match(uiText(L.cfg, withTime).details_message, /\d{1,2}:\d{2} (AM|PM)/);
});

test("one question per reply at most", () => {
  // A generous budget here so this exercises the per-reply "second_question" guard specifically, not
  // "question_over_budget" (question_budget is 1 by default now — see "guard enforces bubble count and question budget").
  const LL = { ...L, cfg: clone() }; LL.cfg.style.question_budget = 5;
  const { ctx, st } = fresh(rafeeq);
  const r = guardReply(LL, ctx, st, "Aapko kya lagta hai?||Kahan rukawat lagti hai?||Shani ka asar hai.");
  assert.deepEqual(r.bubbles, ["Aapko kya lagta hai?", "Shani ka asar hai."]);
  assert.ok(r.flags.includes("dropped:second_question"));
});

test("reply instructions come from config.yaml and are checked", () => {
  const { ctx, st } = fresh(rafeeq);
  const c = clone(); c.reply_instructions = { ...c.reply_instructions, gather: "Answer in exactly one warm line about their question." };
  assert.match(buildSystemPrompt({ ...L, cfg: c }, ctx, st, 2, 110), /Answer in exactly one warm line/, "a fresh session's first message is stage \"gather\"");
  const bad = clone(); bad.reply_instructions = { answer: "Use {name} here please, it is fine." , nonsense: "x".repeat(20) } as never;
  const errs = validateConfig(bad, L.template).join(" | ");
  assert.match(errs, /reply_instructions\.nonsense is not a known key/);
  assert.match(errs, /reply_instructions\.answer uses unknown \{name\}/);
});
