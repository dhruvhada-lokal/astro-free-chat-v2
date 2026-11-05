// Chat service: everything the API routes do, in one place.
//
// The clock: by default the free time starts when the chat page opens (timing.clock_starts: open), which gives
// the AT-style urgency; "first_message" starts it at the first question instead. The server owns the clock;
// the browser only displays it.
// Omkar replies to every message, and when the user goes quiet (timing.idle_nudge_seconds) he carries on by himself,
// until the closing line at closing_at_seconds_left. Nothing is ever sent after the chat has ended.

import {
  load, buildContext, newSession, openingBubbles, chartIntro, chartLine, runTurn, runNudge, bubblesFor, forCohort, cohortOf, forLanguage, languageOf, uiText, cardText, handoffUrl, fallbackUrl, MAX_USER_CHARS, topicPromptLine, stageFor,
} from "../engine/engine.ts";
import type { Loaded, Context, ChatMessage, TurnLog, OnboardLabels } from "../engine/engine.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getStore } from "./store.ts";
import type { Session, StoredMessage } from "./store.ts";
import { callModel } from "./llm.ts";
import { buildKundli } from "./kundli.ts";
import type { KundliView } from "./kundli.ts";

export const MAX_USER_MESSAGES = 15;
const DUPLICATE_WINDOW_MS = 5000; // same text again within this window = a double tap or a retry, not a new question
export const EVENT_NAMES = ["link_opened", "handoff_card_shown", "cta_tapped", "ended_screen_viewed", "page_hidden", "back_to_app"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const isDev = () => process.env.NODE_ENV !== "production";

// Config is re-read whenever config.yaml or prompt_template.md changes on disk, so edits apply to the next
// message without a restart. A broken edit is refused (the last good config keeps running, and the error is logged).
// On Vercel the files only change with a deploy.
let cached: { L: Loaded; stamp: string } | null = null;
function configStamp(): string {
  const dir = join(process.cwd(), "config");
  return ["config.yaml", "prompt_template.md"].map((f) => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } }).join(":");
}
export function config(): Loaded {
  if (isDev()) {
    const L = load();
    // Local testing only: DEV_FREE_SECONDS=30 shortens the chat so the hand-off can be tried quickly.
    const dev = Number(process.env.DEV_FREE_SECONDS);
    if (dev > L.cfg.timing.closing_at_seconds_left) L.cfg.timing.free_seconds = dev;
    return L;
  }
  const stamp = configStamp();
  if (!cached || cached.stamp !== stamp) {
    try {
      cached = { L: load(), stamp };
    } catch (err) {
      if (!cached) throw err;
      console.error(`config edit refused, still running ${cached.L.cfg.experiment.prompt_version}:`, (err as Error).message);
      cached = { ...cached, stamp }; // don't re-read the broken file on every request; the next save is tried again
    }
  }
  return cached.L;
}

export type View = {
  status: "invalid" | "active" | "ended" | "choose_language";
  justStarted: boolean;        // true only on the very first open: the page animates the opening once
  clockStarted: boolean;       // with clock_starts: first_message, false until the first question
  ui: Record<string, string>;
  persona: { name: string; label: string; avatar: string; verified: boolean };
  messages: StoredMessage[];
  secondsLeft: number;
  freeSeconds: number;
  idleNudgeSeconds: number;    // 0 = Omkar never speaks first
  topicWaitTypingSeconds: number; // the post-greeting pause before "typing…" shows, if they haven't said anything
  topicWaitSeconds: number;       // ...and then the proactive topic question is sent
  topicAsked: boolean;            // that proactive question has already gone out — the page stops waiting for it
  closingAt: number;
  handoffAt: number;
  ctaCountdown: number;        // seconds the button counts down once the card appears
  handoffUrl: string;
  fallbackUrl: string;         // app link didn't open (app not installed) → this, e.g. the Play Store
  closed: boolean;
  crisis: boolean;
  chart: { moonSign: string; mahadasha: string; antardasha: string; kundli: KundliView | null } | null;
  pacing: Loaded["cfg"]["pacing"];
  // The "engage" ladder turn the user's NEXT message will trigger (0 = not applicable or past the fixed sequence;
  // 1 = engage_bridge — the bridge bubble AND the one real question, together — 2 = engage_cliffhanger, 3 =
  // engage_stall). Fully deterministic from SessionState.engageTurns, so the client can pick the right pre-typing
  // pause (see pacing.post_kundli_gap_ms) before it even sends the message — unlike the answer-phase reveal, which
  // depends on the model's own reply.
  upcomingEngageTurn: number;
  canRestart: boolean;         // local development only
  promptVersion: string;
  languageOptions: { key: string; label: string }[]; // on every status — the onboarding flow's own, local language pick needs this before any token/session exists
  languagePrompt: string;      // the line shown above the language buttons
  brandName: string;           // "AstroLokal" — on every status, for screens shown before Omkar (picker, onboarding)
  brandLogo: string;
  onboardingLabels: Record<string, Partial<OnboardLabels>>; // self-serve onboarding form copy, by language key
};

export type OutMessage = Pick<StoredMessage, "role" | "text">;
export type SendResult =
  // ladderTurn: this reply's SessionState.engageTurns (see TurnLog.ladder_turn) — 1-3 means it's part of the fixed
  // engage_bridge/engage_cliffhanger/engage_stall sequence, and the client paces the whole reply on the same
  // deliberate rhythm as the kundli reveal (post_kundli_gap_ms/post_kundli_typing_ms); turn 1 additionally gets a
  // longer pause between its two bubbles (pacing.dramatic_gap_ms) before the question.
  // chartLineIndex: the position of the chart_line bubble in `messages`, when this reply is the first-answer
  // kundli reveal (empathy → chart_intro → card? → chart_line → finding → hook) — null otherwise. The whole
  // reveal is paced the same slow way whether or not the card itself is in these messages (no birth time skips
  // the card, and that must not silently fall back to fast, length-based pacing); this index also tells the
  // client exactly where the longer pause (pacing.dramatic_gap_ms) goes, since without a card there's no
  // "kundli"-role bubble to hang that pause off of.
  | { ok: true; messages: OutMessage[]; view: View; ladderTurn?: number; chartLineIndex?: number | null }
  | { ok: false; error: string; view: View };

const now = () => new Date().toISOString();
const TOKEN_RX = /^[A-Za-z0-9_-]{6,64}$/;

function secondsLeft(L: Loaded, s: Session): number {
  if (!s.clock_started_at) return L.cfg.timing.free_seconds;
  // Time spent waiting on a model call (success, retry, or timeout — see SessionState.llmWaitMs) doesn't count
  // against the user's free time: it's our own backend being slow, not something they should pay for.
  const elapsed = (Date.now() - new Date(s.clock_started_at).getTime()) / 1000 - (s.state.llmWaitMs ?? 0) / 1000;
  return Math.max(0, Math.ceil(L.cfg.timing.free_seconds - elapsed));
}

function viewBase(L: Loaded, ctx: Context | null, token: string) {
  const labels = L.cfg.language_picker_labels ?? {};
  return {
    persona: {
      name: L.cfg.persona.name, label: L.cfg.persona.header_label, avatar: L.cfg.persona.avatar_url ?? "",
      verified: L.cfg.persona.verified_badge === true,
    },
    freeSeconds: L.cfg.timing.free_seconds,
    idleNudgeSeconds: L.cfg.timing.idle_nudge_seconds,
    topicWaitTypingSeconds: L.cfg.timing.topic_wait_typing_seconds,
    topicWaitSeconds: L.cfg.timing.topic_wait_seconds,
    closingAt: L.cfg.timing.closing_at_seconds_left,
    handoffAt: L.cfg.timing.handoff_card_at_seconds_left,
    ctaCountdown: L.cfg.timing.cta_countdown_seconds ?? 5,
    handoffUrl: handoffUrl(L, token, ctx?.user),
    fallbackUrl: fallbackUrl(L),
    promptVersion: L.cfg.experiment.prompt_version,
    pacing: L.cfg.pacing,
    canRestart: isDev(),
    brandName: L.cfg.language_picker_brand_name ?? "",
    brandLogo: L.cfg.language_picker_logo ?? "",
    languageOptions: Object.keys(L.cfg.languages ?? {}).map((key) => ({ key, label: labels[key] ?? key })),
    languagePrompt: L.cfg.language_picker_prompt ?? "",
    onboardingLabels: L.cfg.onboarding_labels ?? {},
  };
}

/** Shown instead of the opening when the user's language isn't known yet (Phase 4): no session, no clock. */
function languageChoiceView(L: Loaded, ctx: Context, token: string): View {
  return {
    ...viewBase(L, ctx, token),
    status: "choose_language", justStarted: false, clockStarted: false, topicAsked: false,
    ui: {}, messages: [], secondsLeft: 0, closed: false, crisis: false, chart: null, upcomingEngageTurn: 0,
  };
}

function view(L: Loaded, ctx: Context | null, s: Session | null, token: string, justStarted = false): View {
  const base = viewBase(L, ctx, token);
  if (!ctx || !s) {
    const strip = (t: string) => t.replace(/\{[a-z_]+\}\s*/g, "").trim();
    return {
      ...base, status: "invalid", justStarted: false, clockStarted: false, topicAsked: false, messages: [], secondsLeft: 0,
      closed: true, crisis: false, chart: null, upcomingEngageTurn: 0,
      ui: { invalid_title: strip(L.cfg.ui.invalid_title), invalid_text: strip(L.cfg.ui.invalid_text), cta_label: strip(L.cfg.ui.cta_label) },
    };
  }
  const left = secondsLeft(L, s);
  return {
    ...base,
    status: left > 0 && !s.state.crisis ? "active" : "ended",
    justStarted,
    clockStarted: !!s.clock_started_at,
    topicAsked: !!s.state.topicAsked || !!s.state.chartShown,
    // The ladder turn the user's NEXT message would trigger, if we're already in "engage" — stageFor() doesn't
    // change on its own between messages (only secondsLeft/chartShown/answered move it), so this is a reliable
    // look-ahead, unlike the answer-phase reveal which depends on what the model decides to do with their reply.
    upcomingEngageTurn: stageFor(L, s.state, left) === "engage" ? (s.state.engageTurns ?? 0) + 1 : 0,
    ui: { ...uiText(L.cfg, ctx), card_text: cardText(L.cfg, ctx, s.state.currentTopic ?? ctx.user.last_topic ?? null) },
    messages: s.messages,
    secondsLeft: left,
    closed: s.state.closed || left <= 0,
    crisis: s.state.crisis,
    chart: {
      moonSign: ctx.user.moon_sign,
      mahadasha: ctx.user.dasha_certain === false ? "" : ctx.user.mahadasha,
      antardasha: ctx.user.dasha_certain === false ? "" : ctx.user.antardasha,
      kundli: buildKundli({
        lagna: ctx.user.lagna, tobKnown: !!ctx.user.tob?.trim(), moonSign: ctx.user.moon_sign, planets: ctx.user.planets,
      }),
    },
  };
}

/** The user and the config as their cohort AND language see it (cohorts/languages each override parts of config.yaml). */
async function userConfig(token: string): Promise<{ L: Loaded; ctx: Context | null }> {
  const base = config();
  if (!TOKEN_RX.test(token)) return { L: base, ctx: null };
  const user = await getStore().getUser(token);
  if (!user) return { L: base, ctx: null };
  const afterCohort = forCohort(base, cohortOf(base.cfg, user));
  // Nothing to resolve to yet if the language hasn't been chosen (startOrResume shows the picker in that case).
  const L = user.chat_language ? forLanguage(afterCohort, languageOf(afterCohort.cfg, user.chat_language)) : afterCohort;
  return { L, ctx: buildContext(L.cfg, user) };
}

/**
 * Opens the chat. The first visit writes the opening, like an astrologer joining:
 * the user's details → "Connecting you to Astro Omkar…" → "Astro Omkar has joined" → a short greeting that asks
 * their question. The kundli comes later, with the first answer. Later visits simply resume.
 * `restart` (local development only) wipes the chat so it can be tried again.
 */
export async function startOrResume(token: string, restart = false): Promise<View> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return view(L, null, null, token);
  const store = getStore();
  if (restart && isDev()) await store.resetSessions([token]);

  // No language chosen yet, and nothing has started: show the picker instead of opening (Phase 4).
  // An already-started chat is never sent back through the picker, even if chat_language were somehow unset.
  if (!ctx.user.chat_language && !(await store.getSession(token))) return languageChoiceView(L, ctx, token);

  let created = false;
  const session = await store.withSession<Session>(token, async (existing) => {
    if (existing) return { session: null, result: existing };
    created = true;
    const ui = uiText(L.cfg, ctx);
    const at = now();
    const s: Session = {
      token, started_at: at, clock_started_at: L.cfg.timing.clock_starts === "open" ? at : null,
      arm: ctx.arm.id, cohort: ctx.vars.cohort, prompt_version: L.cfg.experiment.prompt_version, config_hash: L.configHash,
      state: newSession(ctx),
      messages: [
        { role: "details", text: ui.details_message, at },
        { role: "system", text: ui.joining, at },
        { role: "system", text: ui.joined, at },
        ...openingBubbles(L.cfg, ctx).map((text) => ({ role: "ai" as const, text, at })),
      ],
      handoff_shown_at: null, cta_tapped_at: null,
    };
    return { session: s, result: s };
  });
  // "Just started" also covers an immediate second request (React dev mode, a quick reload), so the opening
  // animation still plays once; it never replays after that.
  const fresh = created || (!session.messages.some((m) => m.role === "user") && Date.now() - new Date(session.started_at).getTime() < 4000);
  return view(L, ctx, session, token, fresh);
}

/**
 * The user's pick from the language screen (Phase 4). Saves it (only if not already set — never overwrites an
 * existing choice) and opens the chat in that language. An unrecognised key is ignored and the picker is shown
 * again, rather than silently falling back to the default.
 */
export async function chooseLanguage(token: string, language: string): Promise<View> {
  const base = config();
  if (!TOKEN_RX.test(token)) return view(base, null, null, token);
  const store = getStore();
  const user = await store.getUser(token);
  if (!user) return view(base, null, null, token);
  const key = String(language ?? "").trim().toLowerCase();
  if (!base.cfg.languages?.[key]) {
    const L0 = forCohort(base, cohortOf(base.cfg, user));
    return languageChoiceView(L0, buildContext(L0.cfg, user), token);
  }
  if (!user.chat_language) await store.upsertUsers([{ ...user, chat_language: key }]);
  return startOrResume(token);
}

type TurnOutcome = {
  error: "not_started" | "empty" | "chat_over" | "too_many_messages" | "duplicate" | "not_quiet" | "not_applicable" | null;
  s: Session | null;
  messages?: OutMessage[];
  log?: TurnLog;
  chartLineIndex?: number | null;
};

/**
 * One user message → Omkar's reply (always prompted by the user), persisted with a turn log.
 * First real answer: "kundli dekh raha hoon…" + kundli card + chart line + a 1-line answer.
 * After that: up to 3 short lines.
 */
export async function sendMessage(token: string, rawText: string): Promise<SendResult> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return { ok: false, error: "invalid_token", view: view(L, null, null, token) };
  const text = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_USER_CHARS);
  const store = getStore();

  const out = await store.withSession<TurnOutcome>(token, async (s) => {
    if (!s) return { session: null, result: { error: "not_started", s: null } };
    if (!text) return { session: null, result: { error: "empty", s } };
    if (s.state.closed || secondsLeft(L, s) <= 0) return { session: null, result: { error: "chat_over", s } };
    const lastUser = [...s.messages].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.text === text && Date.now() - new Date(lastUser.at).getTime() < DUPLICATE_WINDOW_MS)
      return { session: null, result: { error: "duplicate", s } };
    if (s.messages.filter((m) => m.role === "user").length >= MAX_USER_MESSAGES)
      return { session: null, result: { error: "too_many_messages", s } };

    const at = now();
    if (!s.clock_started_at) s.clock_started_at = at; // the free time starts with the first question
    const left = secondsLeft(L, s);
    const history: ChatMessage[] = s.messages
      .filter((m): m is StoredMessage & { role: "user" | "ai" } => m.role === "user" || m.role === "ai")
      .map((m) => ({ role: m.role, text: m.text }));
    s.messages.push({ role: "user", text, at });

    const wasChartShown = s.state.chartShown;
    const { bubbles, log } = await runTurn(L, ctx, s.state, text, left, callModel, history, bubblesFor(L, s.state, token));
    // Stage "gather" may have asked its one context-gathering question instead of answering (log.clarifying) —
    // no kundli yet in that case; it lands on whichever reply actually gives the real answer.
    const firstAnswer = !wasChartShown && log.route === "llm" && !log.clarifying;
    const { messages: reply, chartLineIndex } = withChart(L, ctx, s, firstAnswer, bubbles);
    return { session: s, result: { error: null, s, messages: reply, log, chartLineIndex } };
  });

  if (out.error) return { ok: false, error: out.error, view: view(L, ctx, out.s, token) };
  // Logged after the session lock is released (the file store serialises all writes).
  if (out.log) await store.addTurnLog(out.log);
  return {
    ok: true, messages: out.messages ?? [], view: view(L, ctx, out.s, token),
    ladderTurn: out.log?.ladder_turn, chartLineIndex: out.chartLineIndex,
  };
}

/** The first real answer: an empathy opener reacting to what they said, THEN the kundli reveal ("kundli dekh
 *  raha hoon…" → card → chart line), THEN the rest of the finding (bubble count: style.first_answer_bubbles).
 *  Stores the reply. Also returns chartLineIndex — the position of the chart_line bubble, so the client can pace
 *  the dramatic pause before it even when there's no kundli card to hang that pause off (no birth time). */
function withChart(
  L: Loaded, ctx: Context, s: Session, firstAnswer: boolean, bubbles: string[],
): { messages: OutMessage[]; chartLineIndex: number | null } {
  const reply: OutMessage[] = [];
  let chartLineIndex: number | null = null;
  if (firstAnswer) {
    s.state.chartShown = true;
    // Bubble 1 is an empathy opener — reacting to what they just said, before Omkar "looks" at the chart at
    // all — so it goes out ahead of the kundli reveal, not after it with the rest of the finding.
    const [empathy, ...rest] = bubbles;
    if (empathy) reply.push({ role: "ai", text: empathy });
    if (L.cfg.assets?.kundli !== false) {
      const intro = chartIntro(L.cfg, ctx);
      if (intro) reply.push({ role: "ai", text: intro });
      // The card and the chart line only when we're sure of the rashi (no birth time can make it uncertain).
      if (ctx.user.moon_certain !== false) reply.push({ role: "kundli", text: uiText(L.cfg, ctx).kundli_caption });
      const line = chartLine(L.cfg, ctx, s.state.currentTopic);
      if (line) { chartLineIndex = reply.length; reply.push({ role: "ai", text: line }); }
    }
    reply.push(...rest.map((b) => ({ role: "ai" as const, text: b })));
  } else {
    reply.push(...bubbles.map((b) => ({ role: "ai" as const, text: b })));
  }
  const at = now();
  for (const m of reply) s.messages.push({ ...m, at });
  return { messages: reply, chartLineIndex };
}

/**
 * The post-greeting pause (timing.topic_wait_seconds) has passed with nothing said yet: Omkar proactively asks
 * his topic question — their own predefined one if it's already known, else the generic one. Scripted, no model
 * call, sent at most once (idempotent against a client retry or a user message that arrived in the same moment).
 */
export async function topicPrompt(token: string): Promise<SendResult> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return { ok: false, error: "invalid_token", view: view(L, null, null, token) };
  const store = getStore();

  const out = await store.withSession<TurnOutcome>(token, async (s) => {
    if (!s || !s.clock_started_at) return { session: null, result: { error: "not_started", s } };
    if (s.state.closed || s.state.crisis || secondsLeft(L, s) <= 0) return { session: null, result: { error: "chat_over", s } };
    if (s.state.topicAsked || s.state.chartShown || s.messages.some((m) => m.role === "user"))
      return { session: null, result: { error: "not_applicable", s } };

    s.state.topicAsked = true;
    const msg: OutMessage = { role: "ai", text: topicPromptLine(L.cfg, ctx) };
    s.messages.push({ ...msg, at: now() });
    return { session: s, result: { error: null, s, messages: [msg] } };
  });

  if (out.error) return { ok: false, error: out.error, view: view(L, ctx, out.s, token) };
  return { ok: true, messages: out.messages ?? [], view: view(L, ctx, out.s, token) };
}

/**
 * The user has been quiet for timing.idle_nudge_seconds: Omkar carries on by himself (if he hasn't read the chart
 * yet, he starts the reading). At closing_at_seconds_left he sends the closing line instead. The server checks the
 * silence itself, so a page can't make Omkar talk faster than configured.
 */
export async function nudge(token: string): Promise<SendResult> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return { ok: false, error: "invalid_token", view: view(L, null, null, token) };
  const store = getStore();
  const idleMs = L.cfg.timing.idle_nudge_seconds * 1000;

  const out = await store.withSession<TurnOutcome>(token, async (s) => {
    if (!s || !s.clock_started_at) return { session: null, result: { error: "not_started", s } };
    const left = secondsLeft(L, s);
    if (s.state.closed || s.state.crisis || left <= 0) return { session: null, result: { error: "chat_over", s } };
    const closing = left <= L.cfg.timing.closing_at_seconds_left;
    const lastAt = Math.max(...s.messages.map((m) => new Date(m.at).getTime()).filter(Number.isFinite), 0);
    // A little slack for the page's own timer; without it a nudge could be refused by a second.
    if (!closing && (idleMs === 0 || Date.now() - lastAt < idleMs - 3000)) return { session: null, result: { error: "not_quiet", s } };

    const history: ChatMessage[] = s.messages
      .filter((m): m is StoredMessage & { role: "user" | "ai" } => m.role === "user" || m.role === "ai")
      .map((m) => ({ role: m.role, text: m.text }));
    const firstAnswer = !s.state.chartShown && !closing;
    const { bubbles, log } = await runNudge(L, ctx, s.state, left, callModel, history, bubblesFor(L, s.state, token));
    if (!bubbles.length && !s.state.closed) return { session: null, result: { error: "chat_over", s } };
    const { messages: reply, chartLineIndex } = withChart(L, ctx, s, firstAnswer, bubbles);
    return { session: s, result: { error: null, s, messages: reply, log, chartLineIndex } };
  });

  if (out.error) return { ok: false, error: out.error, view: view(L, ctx, out.s, token) };
  if (out.log) await store.addTurnLog(out.log);
  return {
    ok: true, messages: out.messages ?? [], view: view(L, ctx, out.s, token),
    ladderTurn: out.log?.ladder_turn, chartLineIndex: out.chartLineIndex,
  };
}

/** Funnel events from the page. Unknown names are ignored. */
export async function recordEvent(token: string, name: string, props: Record<string, unknown> = {}): Promise<boolean> {
  if (!TOKEN_RX.test(token) || !(EVENT_NAMES as readonly string[]).includes(name)) return false;
  const L = config();
  const store = getStore();
  if (!(await store.getUser(token))) return false;
  const safeProps = Object.fromEntries(
    Object.entries(props).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 10),
  );
  await store.addEvent({
    token, name, at: now(),
    props: { ...safeProps, prompt_version: L.cfg.experiment.prompt_version, config_hash: L.configHash },
  });
  if (name === "handoff_card_shown" || name === "cta_tapped") {
    await store.withSession<null>(token, async (s) => {
      if (!s) return { session: null, result: null };
      if (name === "handoff_card_shown" && !s.handoff_shown_at) s.handoff_shown_at = now();
      else if (name === "cta_tapped" && !s.cta_tapped_at) s.cta_tapped_at = now();
      else return { session: null, result: null };
      return { session: s, result: null };
    });
  }
  return true;
}
