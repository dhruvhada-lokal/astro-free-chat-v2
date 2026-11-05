// Astrolokal AI free chat engine.
// Everything the chat needs besides storage and the LLM call itself: config loading + validation,
// arm assignment, prompt building, scripted lines, message routing, the reply guard, and turn logs.
// The LLM is passed in as a function, so this file has no provider dependency.
// Plain Node-compatible TypeScript (runs under `node file.ts` and inside Next.js).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";

// ── Types ────────────────────────────────────────────────────────────────────

export type UserInput = {
  token: string;              // opaque per-user code from the WATI link (never a phone number)
  user_id?: string | null;    // Astrolokal user id, kept so chats can be joined with purchases (never shown or put in a URL)
  name: string;
  gender?: string | null;
  dob: string;                // YYYY-MM-DD
  tob?: string | null;        // HH:MM (24h), null/"" if unknown
  pob?: string | null;
  language?: string | null;   // e.g. "Hinglish", "Hindi"
  moon_sign: string;          // computed by the wrapper
  mahadasha: string;
  antardasha: string;
  lagna?: string | null;
  last_topic?: string | null; // one of config.topics keys
  last_summary?: string | null;
  last_consult_date?: string | null; // YYYY-MM-DD
  consult_count?: number | null;
  windows?: Record<string, string> | null; // computed windows per topic (used by insight_level: specific)
  planets?: Record<string, string> | string | null; // optional full chart from the wrapper, e.g. {Su: "Mesh 12.4"} or "Su:Mesh 12.4;Ma:Kark"
  cohort?: string | null;          // which journey this user is in (config.cohorts); empty = default_cohort
  chat_language?: string | null;   // which config.languages key this chat is shown in; null = not chosen yet (the picker shows)
  wallet_balance?: number | null;  // at list time; > 0 → the CTA goes straight to a chat, else to recharge first
  moon_certain?: boolean;          // false: no birth time and the rashi changes that day → rashi is never stated or drawn
  dasha_certain?: boolean;         // false: same for the dasha
  tob_asked?: boolean;             // false: this pipeline never asked for a birth time at all (e.g. self-serve's
                                    // shorter form) — the details card says nothing about it, rather than "not known"
};

export type Arm = { id: string; weight: number; insight_level?: string; allow?: string[] };
type Pattern = { reason: string; pattern: string };

// Self-serve onboarding form copy (Phase 5) — see Config.onboarding_labels. The form only asks for name and
// date of birth (gender, time and place of birth don't change the chart enough to bother asking — see
// chart.ts). Day/Month/Year and month names are deliberately left in English in every language, same choice
// as kundli_lagna_chart above.
export type OnboardLabels = {
  title: string; name_label: string; dob_label: string;
  submit_label: string; submit_busy: string; error_missing: string; error_failed: string;
};

export type Config = {
  experiment: { id: string; prompt_version: string; arms: Arm[] };
  timing: {
    free_seconds: number; clock_starts: "open" | "first_message"; pull_until_seconds_left: number; idle_nudge_seconds: number; cta_countdown_seconds?: number;
    closing_at_seconds_left: number; handoff_card_at_seconds_left: number; llm_timeout_ms: number;
    // The pause right after the opening greeting, before Omkar proactively asks what they want to know (unknown
    // topic) or their predefined topic question (known topic) — only fires if they haven't said anything by then.
    topic_wait_typing_seconds: number; topic_wait_seconds: number;
  };
  model: { name: string; thinking?: string; temperature: number; max_output_tokens: number };
  pacing: {
    read_delay_ms: number; typing_min_ms: number; typing_ms_per_char: number; typing_max_ms: number;
    between_messages_ms: number; system_note_ms: number; kundli_gap_ms: number; kundli_ms: number;
    post_kundli_gap_ms: number; post_kundli_typing_ms: number; dramatic_gap_ms: number;
    long_bubble_words: number; long_bubble_typing_ms: number;
  };
  persona: { name: string; avatar_url: string; header_label: string; verified_badge?: boolean; voice: string; disclosure_line: string };
  style: {
    max_bubbles: number; first_answer_bubbles: number; early_replies: number; later_bubbles: number[];
    max_words_per_bubble: number; question_budget: number; separator: string;
  };
  insight_levels: Record<string, string>;
  scripted: {
    opening: string[]; topic_hook: Record<string, string>; topic_followup?: Record<string, string>;
    chart_intro?: string; chart_line: string; chart_line_unsure: Record<string, string>; closing: string[];
    fallback_reply: string; fallback_reply_alt?: string; health_reply: string; crisis_reply: string[];
    // opening[0] ("Namaste {name} ji") is shared by both; opening[1] ("Aapka swagat hai.") is used when the
    // topic isn't known yet, returning_greeting ("Kaise hai aap?") when it is (a returning user). Either way,
    // the actual topic question (topic_prompt, or topic_hook[last_topic]) is asked later, not bundled in here —
    // see timing.topic_wait_seconds.
    returning_greeting: string; topic_prompt: string;
  };
  monthly_line: string;
  topics: Record<string, string[]>;
  guardrails: { banned: Pattern[]; crisis: string[]; injection: string[]; ai_question: string[] };
  handoff: { deeplink_with_balance: string; deeplink_no_balance: string; fallback_url?: string; utm: string; utm_on_app_links?: boolean };
  assets?: { kundli: boolean; last_chat: boolean };
  default_cohort?: string;
  cohorts?: Record<string, Record<string, unknown>>;
  default_language?: string;
  languages?: Record<string, Record<string, unknown>>;
  language_picker_labels?: Record<string, string>; // native-script display name per language key, for the picker screen
  language_picker_prompt?: string; // the one line shown above the language buttons
  language_picker_brand_name?: string; // shown on the picker screen instead of persona.name (no language chosen yet)
  language_picker_logo?: string; // "" = an initial letter, a file in public/, or an https:// link — same rules as persona.avatar_url
  // Self-serve onboarding form labels (Phase 5), by language — picked before the form shows, so its own fields
  // can be in the user's language too. Hinglish needs no entry: the form's own English text is that default,
  // same as languages.hinglish: {}. Any field left out of a language's entry falls back to the English default.
  onboarding_labels?: Record<string, Partial<OnboardLabels>>;
  source?: import("../lib/sync.ts").SourceConfig;
  ui: Record<string, string>;
  card_text_by_topic?: Record<string, string>;
  reply_instructions?: Partial<Record<"answer" | "start" | "gather" | "engage" | "engage_doubt" | "engage_bridge" | "hook" | "hook_after_ladder" | "quiet" | "engage_cliffhanger" | "engage_stall", string>>;
};

export type Loaded = { cfg: Config; template: string; configHash: string };

export type SessionState = {
  questionsAsked: number;
  currentTopic: string | null;
  crisis: boolean;
  closed: boolean;
  turns: number;
  chartShown?: boolean;   // the kundli card goes out with the first real answer
  answered?: boolean;     // their first question has had its real answer
  hooked?: boolean;       // the open thread has been planted (the scripted closing line is then not needed)
  clarifyRounds?: number; // how many of stage "gather"'s OWN clarifying questions have been used — see MAX_CLARIFY_ROUNDS.
                           // Separate from noTopicRounds below: a "hi" with literally nothing to go on must not eat into
                           // the budget meant for "they gave a topic, still need one more detail" — those are different.
  noTopicRounds?: number;  // how many times the deterministic "no topic at all" re-ask (route()'s clarify_topic) has
                           // fired — capped the same way, so someone who only ever says "hi" doesn't loop forever,
                           // but it never touches clarifyRounds, and reaching the cap just falls through to the model.
  topicAsked?: boolean;   // the proactive post-greeting topic question has already been sent (timing.topic_wait_seconds)
  topicNamedByUser?: boolean; // they've named a topic themselves at least once in this chat — see route()'s deterministic
                               // clarify_topic check, which must not fire again just because a LATER message (e.g. a
                               // one-line answer to a follow-up) happens not to repeat the topic word
  engageTurns?: number;   // how many "engage" replies so far. This also drives the fixed opening sequence of the
                           // phase: turn 1 = engage_bridge (the bridge AND the one real question, together), turn
                           // 2 = engage_cliffhanger, turn 3 = engage_stall — the same order every chat, then every
                           // 3rd turn after that carries a doubt line (see ENGAGE_DOUBT_EVERY).
  lastAsked?: boolean;    // the previous reply ended on a question — never two in a row (style.question_budget)
  llmWaitMs?: number;     // total time spent waiting on model calls this session (success, retry, or timeout) —
                           // secondsLeft() (src/lib/chat.ts) subtracts this from elapsed wall-clock time, so the
                           // free chat's clock is never silently drained by a slow or failing model call.
};

export type ChatMessage = { role: "user" | "ai"; text: string };

export type TurnLog = {
  session_token: string; experiment_id: string; arm: string; prompt_version: string; config_hash: string;
  model: string; turn: number; seconds_left: number; route: string; user_text: string; cohort?: string;
  bubbles: string[]; flags: string[]; latency_ms: number | null; used_fallback: boolean; retried: boolean;
  show_handoff: boolean;
  clarifying: boolean; // stage "gather" asked its one context-gathering question instead of answering
  ladder_turn: number; // 0 outside "engage"; else SessionState.engageTurns for this reply — 1 = engage_bridge (the
                        // bridge bubble + the one real question bubble, together), 2 = engage_cliffhanger, 3 =
                        // engage_stall, 4+ = past the fixed sequence. The client uses this to pace the reply (fixed
                        // pause-then-type rhythm for 1-3, a longer pause between the two bubbles of turn 1 — see
                        // SendResult.ladderTurn).
};

// ── Loading & validation ─────────────────────────────────────────────────────

const SCRIPT_VARS = ["name", "moon_sign", "mahadasha", "antardasha", "last_topic_label", "persona_name", "monthly_line"];
const UI_VARS = [...SCRIPT_VARS, "dob_label", "tob_label", "pob", "gender_label"];
const LINK_VARS = ["token", "prompt_version", "cohort", "arm", "balance"];
const INSIGHT_VARS = ["window_for_topic"];
const REQUIRED_UI = [
  "joining", "joined", "details_message", "tob_unknown", "kundli_caption", "kundli_lagna_chart", "kundli_moon_chart", "moon_sign_label", "dasha_label", "day_chip",
  "strip_during", "strip_reveal", "time_up", "time_up_status", "card_text", "cta_label", "cta_subtext",
  "card_offer", "status_online", "status_typing", "strip_cta", "input_placeholder", "send_error", "ended_title", "invalid_title", "invalid_text",
];

export function load(configDir = join(process.cwd(), "config")): Loaded {
  const raw = readFileSync(join(configDir, "config.yaml"), "utf8");
  const template = readFileSync(join(configDir, "prompt_template.md"), "utf8");
  const cfg = parse(raw) as Config;
  const errors = validateConfig(cfg, template);
  const avatar = cfg?.persona?.avatar_url ?? "";
  if (avatar.startsWith("/") && !existsSync(join(configDir, "..", "public", avatar)))
    errors.push(`persona.avatar_url points to "${avatar}", but public${avatar} does not exist`);
  if (!errors.length) errors.push(...validateCohorts(cfg, template));
  if (!errors.length) errors.push(...validateLanguages(cfg, template));
  if (errors.length) throw new Error("config.yaml has problems:\n  - " + errors.join("\n  - "));
  return { cfg, template, configHash: createHash("sha256").update(raw + template).digest("hex").slice(0, 12) };
}

// ── Cohorts ──────────────────────────────────────────────────────────────────
// A cohort overrides only what is different for that journey (any section except experiment/cohorts);
// everything else comes from the main config. Arrays are replaced, objects are merged.

const COHORT_LOCKED = [
  "experiment", "cohorts", "default_cohort", "languages", "default_language",
  "language_picker_labels", "language_picker_prompt", "language_picker_brand_name", "language_picker_logo", "onboarding_labels",
];

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out as T;
}

function validateCohorts(cfg: Config, template: string): string[] {
  const e: string[] = [];
  const cohorts = cfg.cohorts ?? {};
  const def = cfg.default_cohort ?? "";
  if (Object.keys(cohorts).length && !(def in cohorts)) e.push(`default_cohort "${def}" must be one of: ${Object.keys(cohorts).join(", ")}`);
  for (const [name, over] of Object.entries(cohorts)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) { e.push(`cohort name "${name}" must be lowercase letters, digits or _`); continue; }
    for (const k of Object.keys(over ?? {})) if (COHORT_LOCKED.includes(k)) e.push(`cohorts.${name} cannot change "${k}"`);
    for (const msg of validateConfig(merge(cfg, over ?? {}), template)) e.push(`cohorts.${name}: ${msg}`);
  }
  return e;
}

export function cohortOf(cfg: Config, user: Pick<UserInput, "cohort">): string {
  const c = (user.cohort ?? "").trim();
  return c && cfg.cohorts?.[c] ? c : cfg.default_cohort ?? "default";
}

const cohortCache = new WeakMap<Loaded, Map<string, Loaded>>();
/** The config as this user's cohort sees it. Same object for the same cohort (cached per load). */
export function forCohort(L: Loaded, cohort: string): Loaded {
  const over = L.cfg.cohorts?.[cohort];
  if (!over || !Object.keys(over).length) return L;
  let m = cohortCache.get(L);
  if (!m) cohortCache.set(L, (m = new Map()));
  let c = m.get(cohort);
  if (!c) m.set(cohort, (c = { ...L, cfg: merge(L.cfg, over) }));
  return c;
}

// ── Languages ────────────────────────────────────────────────────────────────
// A second axis, independent of cohorts: which language the chat is shown in. A language override replaces
// scripted text and UI copy like a cohort would — but its guardrail patterns (banned/crisis/injection/ai_question)
// are ADDED to the base set, never replace it, so switching language can never silently drop a safety check
// written in Hindi/English (someone can always type in the other language mid-chat, whatever they picked).

const LANGUAGE_LOCKED = [
  "experiment", "cohorts", "default_cohort", "languages", "default_language",
  "language_picker_labels", "language_picker_prompt", "language_picker_brand_name", "language_picker_logo", "onboarding_labels",
];
const GUARDRAIL_LISTS = ["banned", "crisis", "injection", "ai_question"] as const;

function unionGuardrails(base: Config["guardrails"], over: Partial<Config["guardrails"]> | undefined): Config["guardrails"] {
  if (!over) return base;
  const out = { ...base };
  for (const k of GUARDRAIL_LISTS) {
    const added = (over[k] as unknown[] | undefined) ?? [];
    if (!added.length) continue;
    const seen = new Set((base[k] as unknown[]).map((x) => JSON.stringify(x)));
    out[k] = [...base[k], ...added.filter((x) => !seen.has(JSON.stringify(x)))] as never;
  }
  return out;
}

/** Like merge(), but guardrails union instead of replace (see note above). */
function mergeLanguage(base: Config, over: Record<string, unknown>): Config {
  const { guardrails, ...rest } = over as { guardrails?: Partial<Config["guardrails"]> };
  const merged = merge(base, rest);
  merged.guardrails = unionGuardrails(base.guardrails, guardrails);
  return merged;
}

function validateLanguages(cfg: Config, template: string): string[] {
  const e: string[] = [];
  const languages = cfg.languages ?? {};
  const def = cfg.default_language ?? "";
  if (Object.keys(languages).length && !(def in languages)) e.push(`default_language "${def}" must be one of: ${Object.keys(languages).join(", ")}`);
  if (Object.keys(languages).length) {
    if (!cfg.language_picker_prompt?.trim()) e.push("language_picker_prompt is missing (the line shown above the language buttons)");
    if (!cfg.language_picker_brand_name?.trim()) e.push("language_picker_brand_name is missing (shown on the picker screen)");
    const logo = cfg.language_picker_logo ?? "";
    if (!(logo === "" || /^\/[\w./-]+\.(jpe?g|png|webp)$/i.test(logo) || /^https:\/\/\S+$/.test(logo)))
      e.push(`language_picker_logo must be "", a file in public/ like "/logo/astrolokal.png", or an https:// link (got "${logo}")`);
  }
  for (const [name, over] of Object.entries(languages)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) { e.push(`language name "${name}" must be lowercase letters, digits or _`); continue; }
    for (const k of Object.keys(over ?? {})) if (LANGUAGE_LOCKED.includes(k)) e.push(`languages.${name} cannot change "${k}"`);
    for (const msg of validateConfig(mergeLanguage(cfg, over ?? {}), template)) e.push(`languages.${name}: ${msg}`);
    if (!cfg.language_picker_labels?.[name]?.trim())
      e.push(`language_picker_labels.${name} is missing (needed so the language picker has something to show)`);
  }
  return e;
}

/** Which language key a raw value (from Redash, or a user's own pick) resolves to; unknown/empty → default_language. */
export function languageOf(cfg: Config, raw: string | null | undefined): string {
  const l = (raw ?? "").trim().toLowerCase();
  return l && cfg.languages?.[l] ? l : cfg.default_language ?? "default";
}

const languageCache = new WeakMap<Loaded, Map<string, Loaded>>();
/** The config as this language sees it (scripted text, UI copy and guardrails merged — guardrails are added to,
 *  never replace, the base set). Same object for the same language (cached per load). */
export function forLanguage(L: Loaded, language: string): Loaded {
  const over = L.cfg.languages?.[language];
  if (!over || !Object.keys(over).length) return L;
  let m = languageCache.get(L);
  if (!m) languageCache.set(L, (m = new Map()));
  let c = m.get(language);
  if (!c) m.set(language, (c = { ...L, cfg: mergeLanguage(L.cfg, over) }));
  return c;
}

function placeholders(s: string): string[] {
  return [...String(s).matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}

export function validateConfig(cfg: Config, template: string): string[] {
  const e: string[] = [];
  const need = (cond: unknown, msg: string) => { if (!cond) e.push(msg); };

  need(cfg?.experiment?.id, "experiment.id is missing");
  need(cfg?.experiment?.prompt_version, "experiment.prompt_version is missing");
  const arms = cfg?.experiment?.arms ?? [];
  need(arms.length > 0, "experiment.arms needs at least one arm");
  const total = arms.reduce((a, x) => a + (Number(x.weight) || 0), 0);
  need(total === 100, `arm weights add up to ${total}, must be 100`);
  need(new Set(arms.map((a) => a.id)).size === arms.length, "arm ids must be unique");
  const reasons = new Set((cfg?.guardrails?.banned ?? []).map((b) => b.reason));
  for (const a of arms) {
    for (const r of a.allow ?? []) need(reasons.has(r), `arm '${a.id}' allows unknown guard reason '${r}'`);
    const lvl = a.insight_level ?? "";
    need(cfg.insight_levels?.[lvl], `arm '${a.id}' uses insight_level '${lvl}' which is not defined in insight_levels`);
  }

  const t = cfg.timing ?? ({} as Config["timing"]);
  need(t.free_seconds > t.closing_at_seconds_left, "timing.free_seconds must be greater than closing_at_seconds_left");
  need(t.closing_at_seconds_left >= t.handoff_card_at_seconds_left, "closing lines should start at or before the hand-off card (closing_at >= handoff_card_at)");
  need(t.handoff_card_at_seconds_left >= 0, "timing.handoff_card_at_seconds_left must be >= 0");
  need(t.llm_timeout_ms >= 1000, "timing.llm_timeout_ms looks too low (< 1000)");
  need(["open", "first_message"].includes(t.clock_starts), 'timing.clock_starts must be "open" or "first_message"');
  need(t.pull_until_seconds_left > t.closing_at_seconds_left, "timing.pull_until_seconds_left must be above closing_at_seconds_left");
  need(t.cta_countdown_seconds === undefined || (Number.isInteger(t.cta_countdown_seconds) && t.cta_countdown_seconds >= 0 && t.cta_countdown_seconds <= 30),
    "timing.cta_countdown_seconds must be 0–30");
  need(t.idle_nudge_seconds === 0 || (t.idle_nudge_seconds >= 10 && t.idle_nudge_seconds <= 60), "timing.idle_nudge_seconds must be 0 (off) or 10–60");
  need(t.topic_wait_typing_seconds > 0 && t.topic_wait_typing_seconds < t.topic_wait_seconds,
    "timing.topic_wait_typing_seconds must be > 0 and less than topic_wait_seconds");
  need(t.topic_wait_seconds > 0 && t.topic_wait_seconds <= 30, "timing.topic_wait_seconds must be 0–30");

  const pc = cfg.pacing ?? ({} as Config["pacing"]);
  for (const k of ["read_delay_ms", "typing_min_ms", "typing_ms_per_char", "typing_max_ms", "between_messages_ms", "system_note_ms", "kundli_gap_ms", "kundli_ms", "post_kundli_gap_ms", "post_kundli_typing_ms", "dramatic_gap_ms"] as const)
    need(Number.isFinite(pc[k]) && pc[k] >= 0 && pc[k] <= 5000, `pacing.${k} must be 0–5000 ms`);
  need(!(pc.typing_min_ms > pc.typing_max_ms), "pacing.typing_min_ms must not exceed typing_max_ms");
  // A bubble this long is never dropped any more (see guardReply) — it's kept and just typed out slower.
  need(Number.isInteger(pc.long_bubble_words) && pc.long_bubble_words >= cfg.style.max_words_per_bubble,
    "pacing.long_bubble_words must be an integer >= style.max_words_per_bubble");
  need(Number.isFinite(pc.long_bubble_typing_ms) && pc.long_bubble_typing_ms >= 0 && pc.long_bubble_typing_ms <= 15000,
    "pacing.long_bubble_typing_ms must be 0–15000 ms");

  const m = cfg.model ?? ({} as Config["model"]);
  need(/^gemini-[\w.-]+$/.test(m.name ?? ""), `model.name must be a Gemini model id like "gemini-3.5-flash-lite" (got "${m.name}")`);
  need(m.thinking === undefined || ["minimal", "low", "medium", "high"].includes(m.thinking), "model.thinking must be minimal, low, medium or high");
  need(m.temperature >= 0 && m.temperature <= 2, "model.temperature must be between 0 and 2");
  need(m.max_output_tokens >= 50 && m.max_output_tokens <= 2000, "model.max_output_tokens should be 50–2000");

  const s = cfg.style ?? ({} as Config["style"]);
  need(s.max_bubbles >= 1 && s.max_bubbles <= 4, "style.max_bubbles should be 1–4");
  need(s.first_answer_bubbles >= 1 && s.first_answer_bubbles <= s.max_bubbles, "style.first_answer_bubbles should be 1–max_bubbles");
  need(Number.isInteger(s.early_replies) && s.early_replies >= 0, "style.early_replies must be a whole number >= 0");
  need(Array.isArray(s.later_bubbles) && s.later_bubbles.length > 0 && s.later_bubbles.every((n) => n >= 1 && n <= s.max_bubbles),
    "style.later_bubbles must be a list like [2, 3], each 1–max_bubbles");
  need(s.max_words_per_bubble >= 5 && s.max_words_per_bubble <= 25, "style.max_words_per_bubble should be 5–25");
  need(s.question_budget >= 0, "style.question_budget must be >= 0");
  need(s.separator && s.separator.trim().length > 0, "style.separator is empty");

  need(cfg.scripted?.topic_hook?.default, "scripted.topic_hook.default is required");
  need(cfg.scripted?.returning_greeting, "scripted.returning_greeting is required");
  need(cfg.scripted?.topic_prompt, "scripted.topic_prompt is required");
  const scripted: string[] = [
    ...(cfg.scripted?.opening ?? []), ...Object.values(cfg.scripted?.topic_hook ?? {}),
    ...Object.values(cfg.scripted?.topic_followup ?? {}), ...(cfg.scripted?.closing ?? []),
    cfg.scripted?.chart_line ?? "",
    cfg.scripted?.chart_intro ?? "",
    cfg.scripted?.returning_greeting ?? "", cfg.scripted?.topic_prompt ?? "",
    cfg.scripted?.fallback_reply ?? "", cfg.scripted?.fallback_reply_alt ?? "", cfg.scripted?.health_reply ?? "", ...(cfg.scripted?.crisis_reply ?? []),
    cfg.persona?.disclosure_line ?? "", cfg.monthly_line ?? "",
  ];
  for (const line of scripted) for (const v of placeholders(line))
    need(SCRIPT_VARS.includes(v), `scripted line uses unknown {${v}}: "${line}"`);
  for (const [k, text] of Object.entries(cfg.insight_levels ?? {})) for (const v of placeholders(text))
    need(INSIGHT_VARS.includes(v), `insight_levels.${k} uses unknown {${v}}`);
  for (const v of placeholders(template))
    need(TEMPLATE_VARS.includes(v), `prompt_template.md uses unknown {${v}}`);

  for (const k of REQUIRED_UI) need(typeof cfg.ui?.[k] === "string", `ui.${k} is missing`);
  for (const [k, text] of Object.entries(cfg.ui ?? {})) for (const v of placeholders(text))
    need(UI_VARS.includes(v), `ui.${k} uses unknown {${v}}`);
  // An app link (astrolokal://…) or a web link (https://…). App links need an https fallback for users without the app.
  for (const k of ["deeplink_with_balance", "deeplink_no_balance"] as const)
    need(/^(https:\/\/|[a-z][a-z0-9+.-]*:\/\/)\S+$/i.test(cfg.handoff?.[k] ?? ""), `handoff.${k} must be an app link (astrolokal://…) or start with https://`);
  const appLink = [cfg.handoff?.deeplink_with_balance, cfg.handoff?.deeplink_no_balance].some((u) => u && !/^https:\/\//.test(u));
  need(!appLink || /^https:\/\//.test(cfg.handoff?.fallback_url ?? ""), "handoff.fallback_url (https://, e.g. the Play Store page) is needed with an app link");
  for (const [k, v] of Object.entries(cfg.reply_instructions ?? {})) {
    need(["answer", "start", "gather", "engage", "engage_doubt", "engage_bridge", "hook", "hook_after_ladder", "quiet", "engage_cliffhanger", "engage_stall"].includes(k), `reply_instructions.${k} is not a known key`);
    need(typeof v === "string" && v.trim().length > 10, `reply_instructions.${k} must be a sentence of instructions`);
    for (const p of placeholders(v)) need(k === "start" && p === "topic", `reply_instructions.${k} uses unknown {${p}} (only "start" may use {topic})`);
  }
  if (cfg.source) {
    const src = cfg.source;
    need(Number.isInteger(src.redash_query_id) && src.redash_query_id > 0, "source.redash_query_id must be the Redash query number");
    for (const k of ["user_id", "dob", "tob", "pob", "name", "gender", "cohort"] as const)
      need(typeof src.columns?.[k] === "string" && src.columns[k].trim(), `source.columns.${k} must name a column of the query`);
    const oc = src.on_click ?? {};
    need(oc.cache_minutes === undefined || (oc.cache_minutes >= 0 && oc.cache_minutes <= 240), "source.on_click.cache_minutes must be 0–240");
    need(oc.list_ready_at === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(oc.list_ready_at), "source.on_click.list_ready_at must be a time like \"08:30\" (IST)");
    need(oc.wait_on_miss_seconds === undefined || (oc.wait_on_miss_seconds >= 0 && oc.wait_on_miss_seconds <= 120), "source.on_click.wait_on_miss_seconds must be 0–120");
    const lk = src.links ?? {};
    if (lk.user_id_pattern !== undefined) { try { new RegExp(lk.user_id_pattern); } catch { e.push("source.links.user_id_pattern is not a valid regex"); } }
    need(lk.lookback_days === undefined || (Number.isInteger(lk.lookback_days) && lk.lookback_days >= 0 && lk.lookback_days <= 7), "source.links.lookback_days must be 0–7");
    need(lk.one_chat_every_days === undefined || (Number.isInteger(lk.one_chat_every_days) && lk.one_chat_every_days >= 0 && lk.one_chat_every_days <= 90),
      "source.links.one_chat_every_days must be a whole number 0–90 (0 = no limit)");
    for (const [from, to] of Object.entries(src.cohort_map ?? {}))
      need(!!cfg.cohorts?.[to], `source.cohort_map: "${from}" → "${to}", but "${to}" is not in cohorts`);
  }
  const as = cfg.assets ?? { kundli: true, last_chat: true };
  need(typeof as.kundli === "boolean" && typeof as.last_chat === "boolean", "assets.kundli and assets.last_chat must be true or false");
  for (const [k, text] of Object.entries(cfg.card_text_by_topic ?? {})) {
    need(cfg.topics?.[k], `card_text_by_topic.${k} is not a topic in topics`);
    for (const v of placeholders(text)) need(UI_VARS.includes(v), `card_text_by_topic.${k} uses unknown {${v}}`);
  }
  need(typeof cfg.persona?.name === "string" && cfg.persona.name.trim().length > 0, "persona.name is missing");
  const avatar = cfg.persona?.avatar_url ?? "";
  need(avatar === "" || /^\/[\w./-]+\.(jpe?g|png|webp)$/i.test(avatar) || /^https:\/\/\S+$/.test(avatar),
    `persona.avatar_url must be "", a file in public/ like "/persona/omkar.jpg", or an https:// link (got "${avatar}")`);
  for (const v of placeholders(cfg.handoff?.utm ?? "")) need(LINK_VARS.includes(v), `handoff.utm uses unknown {${v}}`);

  const g = cfg.guardrails;
  for (const p of g?.banned ?? []) { try { new RegExp(p.pattern, "iu"); } catch { e.push(`bad regex (${p.reason}): ${p.pattern}`); } }
  for (const p of [...(g?.crisis ?? []), ...(g?.injection ?? []), ...(g?.ai_question ?? [])]) {
    try { new RegExp(p, "iu"); } catch { e.push(`bad regex: ${p}`); }
  }
  // Scripted lines must pass our own guard, otherwise we would send what we forbid the AI to say.
  if (!e.length) {
    need(cfg.scripted.chart_line, "scripted.chart_line is required");
    need(cfg.scripted.chart_line_unsure?.default, "scripted.chart_line_unsure.default is required");
    const guardable = [
      ...cfg.scripted.opening, ...Object.values(cfg.scripted.topic_hook), ...Object.values(cfg.scripted.topic_followup ?? {}),
      ...cfg.scripted.closing, cfg.scripted.chart_line, ...Object.values(cfg.scripted.chart_line_unsure ?? {}),
      cfg.scripted.chart_intro ?? "", cfg.scripted.returning_greeting, cfg.scripted.topic_prompt, cfg.scripted.fallback_reply,
      cfg.scripted.fallback_reply_alt ?? "",
    ].filter(Boolean);
    for (const line of guardable) {
      const hit = bannedHit(cfg, line);
      if (hit) e.push(`scripted line breaks guardrail '${hit}': "${line}"`);
    }
  }
  return e;
}

// ── Arm assignment (stable: same token → same arm, forever) ──────────────────

export function assignArm(cfg: Config, token: string): Arm {
  const h = createHash("sha256").update(`${cfg.experiment.id}:${token}`).digest();
  const bucket = h.readUInt32BE(0) % 100;
  let acc = 0;
  for (const a of cfg.experiment.arms) { acc += a.weight; if (bucket < acc) return a; }
  return cfg.experiment.arms[cfg.experiment.arms.length - 1];
}

// ── Context ──────────────────────────────────────────────────────────────────

export type Context = { user: UserInput; arm: Arm; insightLevel: string; vars: Record<string, string> };

const TOPIC_LABEL: Record<string, string> = {
  shaadi: "shaadi", naukri: "naukri / kaam", paisa: "paisa", parivaar: "parivaar", pyaar: "pyaar", sehat: "sehat",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(d: string | null | undefined): Date | null {
  if (!d) return null;
  const x = new Date(d + "T00:00:00Z");
  return isNaN(x.getTime()) ? null : x;
}

function ageBand(dob: string, now: Date): string {
  const d = parseDate(dob);
  if (!d) return "unknown";
  const age = Math.floor((now.getTime() - d.getTime()) / (365.25 * 864e5));
  if (age < 18) return "under 18";
  if (age < 25) return "18–24"; if (age < 35) return "25–34"; if (age < 45) return "35–44"; if (age < 60) return "45–59";
  return "60+";
}

function lapsedBand(date: string | null | undefined, now: Date): string {
  const d = parseDate(date);
  if (!d) return "unknown";
  const days = Math.floor((now.getTime() - d.getTime()) / 864e5);
  if (days < 14) return "under 2 weeks ago"; if (days < 30) return "2–4 weeks ago"; if (days < 60) return "1–2 months ago";
  return "over 2 months ago";
}

function countBand(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  if (n <= 1) return "1"; if (n <= 5) return "2–5"; return "6+";
}

function timeOfDayIST(now: Date): string {
  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  const h = Math.floor(minutes / 60);
  if (h < 5) return "raat (late night)"; if (h < 12) return "subah"; if (h < 17) return "dopahar"; if (h < 21) return "shaam";
  return "raat";
}

function tobLabel(tob: string | null | undefined, unknown: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(tob ?? "");
  if (!m) return unknown;
  const h = Number(m[1]); const ampm = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${m[2]} ${ampm}`;
}

function firstName(full: string): string {
  const n = (full || "").trim().split(/\s+/)[0] || "";
  return n ? n[0].toUpperCase() + n.slice(1).toLowerCase() : ""; // unknown → "" and the text tidies itself (see say())
}

export function buildContext(cfg: Config, user: UserInput, now = new Date()): Context {
  const arm = assignArm(cfg, user.token);
  const insightLevel = arm.insight_level ?? Object.keys(cfg.insight_levels)[0];
  const topic = user.last_topic && cfg.topics[user.last_topic] ? user.last_topic : null;
  const dob = parseDate(user.dob);
  const vars: Record<string, string> = {
    name: firstName(user.name),
    gender: user.gender || "unknown",
    gender_label: /^f/i.test(user.gender ?? "") ? "Female" : /^m/i.test(user.gender ?? "") ? "Male" : "",
    dob_label: dob ? `${dob.getUTCDate()} ${MONTHS[dob.getUTCMonth()]} ${dob.getUTCFullYear()}` : "",
    // Never asked at all (not merely left blank) → say nothing, rather than "Birth time not known".
    tob_label: user.tob_asked === false && !user.tob ? "" : tobLabel(user.tob, cfg.ui?.tob_unknown ?? "Birth time not known"),
    pob: user.pob || "",
    age_band: ageBand(user.dob, now),
    language: user.language || "Hinglish",
    moon_sign: user.moon_sign,
    mahadasha: user.mahadasha,
    antardasha: user.antardasha,
    last_topic_label: topic ? TOPIC_LABEL[topic] ?? topic : "",
    persona_name: cfg.persona.name,
    monthly_line: cfg.monthly_line || "",
    lapsed_days_band: lapsedBand(user.last_consult_date, now),
    consult_count_band: countBand(user.consult_count),
    time_of_day: timeOfDayIST(now),
    cohort: cohortOf(cfg, user),
  };
  return { user, arm, insightLevel, vars };
}

export function newSession(ctx: Context): SessionState {
  return { questionsAsked: 0, currentTopic: ctx.user.last_topic ?? null, crisis: false, closed: false, turns: 0 };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Fills a line the USER sees, then tidies what a missing value leaves behind, so nothing looks broken:
 * "Namaste  ji 🙏" → "Namaste ji 🙏" · " ji, ek aur baat" → "Ek aur baat" · "'s Kundli" → "Your Kundli" · "Priya ·  · 14 Aug" → "Priya · 14 Aug".
 */
export function say(tpl: string, vars: Record<string, string>): string {
  const lines = render(tpl, vars).split("\n").map((line) => {
    let t = line
      .replace(/(\s*·){2,}\s*/g, " · ")        // separators with nothing between them, collapsed to one
      .replace(/^\s*·\s*|\s*·\s*$/g, "")      // separators at the start or end
      .replace(/^\s*ji,\s*/i, "")               // "{name} ji, …" without a name
      .replace(/^'s /, "Your ")                  // "{name}'s Kundli" without a name
      .replace(/ {2,}/g, " ").replace(/ ([,.!?…])/g, "$1").trim();
    if (t && t !== line.trim()) t = t[0].toUpperCase() + t.slice(1);
    return t;
  });
  return lines.filter((l, i) => l || i === 0).join("\n");
}

export function render(tpl: string, vars: Record<string, string>): string {
  return String(tpl).replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`missing value for {${k}}`);
    return vars[k];
  });
}

const TEMPLATE_VARS = [
  "prompt_version", "arm_id", "persona_name", "persona_voice", "free_minutes", "insight_instructions",
  "name", "gender", "age_band", "language", "moon_sign", "mahadasha", "antardasha", "lagna_line",
  "current_topic_label", "last_summary_line", "lapsed_days_band", "consult_count_band", "time_of_day",
  "monthly_line_block", "max_bubbles", "max_words", "separator", "questions_left", "disclosure_line", "this_reply",
  "user_facts", "address",
];

// A reply in stage "gather" that asks its one context-gathering question (instead of answering) must start with
// exactly this, so the engine can tell the two apart without guessing from the text itself.
export const CLARIFY_MARKER = "CLARIFY||";

// What this particular reply must do. The arc: answer their first question → keep them talking → one open thread.
// What each reply must do (config.yaml → reply_instructions). These defaults are used for any key left out.
const STAGE_DEFAULTS = {
  answer:
    "Give the real answer now, in THREE bubbles, in the simplest everyday words — " +
    "nothing literary or textbook (never \"vichar\", \"gehra asar\", \"nirnay\"; say \"sochna\", \"zyada asar\", " +
    "\"faisla\"). Bubble 1 (EMPATHY, before you even look at the chart): warmly name what they're going through, " +
    "in plain words — a feeling, not a chart fact. Bubble 2 (THE FINDING, after the kundli card and chart_line — " +
    "never repeat what chart_line already said): acknowledge that right now may be hard, hedged (\"ho sakta hai\"), " +
    "then pivot to hope for THEIR specific topic, e.g. \"Abhi ke samay mein thoda mushkil aa sakti hai, lekin aane " +
    "wala samay aapke liye positive hai.\" Never a chart detail here (dasha/planet/yoga) or their rashi/moon sign — " +
    "chart_line already gave the chart detail. Bubble 3 (THE HOOK): a positive hedge PLUS a soft doubt tied to " +
    "THEIR SPECIFIC situation, telling them to stay a little " +
    "careful about it (\"dhyaan rakhna hoga\", \"savdhan rehna hoga\"), never saying what it is, when, or whether it " +
    "gets better or worse, e.g. \"Sab kuch achha ho sakta hai, lekin is interview ko lekar khaas khayal rakhna hoga.\" " +
    "Leave it completely open, never resolved. All three " +
    "bubbles may run up to about 15 words if the sentence needs it; don't force an unnatural cut. Don't ask anything yet.",
  start:
    "They haven't asked anything yet. Start the reading yourself, on {topic}: one warm, specific thing you see in their chart " +
    "and the planet behind it, so they feel seen and want to reply.",
  gather:
    "This is their very first message and you don't yet know enough to give a real answer. If it already names what they want " +
    "to know AND their specific situation (not just a bare topic word like \"shaadi\" or \"career\" on its own), skip straight " +
    "to the real answer instead, in THREE bubbles, in the simplest everyday words (never \"vichar\", \"gehra asar\", \"nirnay\"; say " +
    "\"sochna\", \"zyada asar\", \"faisla\"): bubble 1 (EMPATHY, before you even look at the chart) warmly names what " +
    "they're going through, in plain words — a feeling, not a chart fact; bubble 2 (THE FINDING, after the kundli " +
    "card and chart_line) acknowledges that right now may be hard, hedged (\"ho sakta hai\"), then pivots to hope " +
    "for THEIR specific topic — never a chart detail or their rashi/moon sign here, chart_line already gave that; " +
    "bubble 3 (THE HOOK) is a positive hedge PLUS a soft doubt tied to their SPECIFIC situation, " +
    "telling them to stay a little careful about it (\"dhyaan rakhna hoga\", \"savdhan rehna hoga\"), never saying what " +
    "it is, when, or whether it gets better or worse. Leave it completely open, never resolved. All three bubbles may run up to about 15 words " +
    "if the sentence needs it. Otherwise — just a greeting (hi, hello, namaste), or a bare topic with " +
    "nothing else — ask ONE short, warm question to understand their actual situation. A bare greeting, or a single topic word " +
    "with nothing else (just \"shaadi\", just \"career\", just \"naukri\"), is NEVER enough on its own, even if you already " +
    "asked them what they wanted to know and this is their reply to that: still ask, don't start a generic reading and don't " +
    "just greet them back. \"They care about: X\" in ABOUT THEM only means a keyword was matched — it is not their actual " +
    "question or situation, and does not count as enough on its own either. If they DID name a topic (a word like \"shaadi\", " +
    "\"career\", \"naukri\"), your question must be about that specific topic (e.g. \"Naukri mein abhi kya dikkat hai?\", " +
    "\"Shaadi ke baare mein kya pooch rahe hain?\") — never repeat the generic \"kis baare mein jaanna chahte hain\" back to " +
    "them, they already answered that part. If their message ALSO asks how you are, or anything else about you, answer that " +
    "in a few warm words first — but that alone never counts as enough: the same reply must still end by asking what they " +
    "want to know, same as above. When (and only when) you're asking that question, " +
    `your entire reply must start with exactly "${CLARIFY_MARKER}" (nothing before it) followed by the one question, so it's ` +
    "never mistaken for the real answer. Never use that marker when you're giving the real answer.",
  engage:
    "Keep them talking and enjoying it, in the simplest everyday words (never \"vichar\", \"gehra asar\", \"nirnay\"; " +
    "say \"sochna\", \"zyada asar\", \"faisla\"). React to what they just said, in their words, then give ONE new small insight about them " +
    "or their question (their nature, what this phase feels like, a detail about the person or the work — never their " +
    "rashi/moon sign). Go a little deeper than before, never all the way. If " +
    "they ask something NEW (where, who, when, how), don't answer it, not even roughly (no place, direction, type of person or " +
    "timing): say you can see it and it's interesting, as a statement, in your own words, e.g. \"Haan, yeh kundli mein saaf dikh raha hai.\"",
  engage_cliffhanger:
    "This is the entire reply — nothing else. End with one bubble naming THEIR specific obstacle (e.g. \"is " +
    "rukawat\"), never a generic truism, followed by exactly \"ke peeche ek wajah hai…\" (ending with \"…\", " +
    "nothing more). Never ask a question here.",
  engage_stall:
    "This is the entire reply — nothing else. In two bubbles: first, say you are still looking closely at that " +
    "one thing for them; second, one positive-leaning line that stops dead right after the word \"agar\" or " +
    "\"magar\", left unfinished.",
  hook:
    "Now leave them on ONE open thread. Name exactly what you have seen and not told yet, tied to their question, and stop there: " +
    "e.g. \"Aapke saatve ghar mein ek aur yog hai…\" or \"Partner ke baare mein ek khaas baat dikh rahi hai.\" " +
    "Don't explain it. If you already opened a thread, deepen that same one with one more tempting detail instead of a new one.",
  hook_after_ladder: "In ONE short bubble, make the thread you already left them on a little sharper. Don't open a new one.",
  quiet: "They have gone quiet for a few seconds. Carry on by yourself, like an astrologer still reading their chart.",
  engage_doubt:
    "This reply must also carry ONE doubt-creating line, as well as your usual reaction and insight — tied to THEIR " +
    "exact topic (name it in your own words), never a generic line that could fit any chat: hint that they'll need " +
    "to watch something about THAT specific thing carefully or stay cautious ahead, WITHOUT saying what it is, e.g. " +
    "\"Is interview ko lekar aapko aage kuch cheezon ka khaas dhyaan rakhna hoga.\" Only ONE planet or dasha, never two " +
    "together. Never resolve it, and never reuse a " +
    "doubt you've already given — that uncertainty is what the full reading is for. End the reply on this uncertain " +
    "note instead of a fully positive one.",
  engage_bridge:
    "This is the entire reply — exactly TWO bubbles, nothing else: their very first reply after the kundli reveal " +
    "ended. Bubble 1: a short, confident pivot into looking closer, direct and sure of yourself, not soft or " +
    "vague, e.g. \"Rukiye, detail mein dekh ke batata hoon.\" Write your own version in this tone, never this " +
    "example word-for-word. Bubble 2: ONE short question (must end in \"?\") about a fact tied to the SPECIFIC " +
    "thing they told you — something already true or already happened, never their hopes or what might happen " +
    "next — the only question \"engage\" ever asks.",
};
export type ReplyInstructions = typeof STAGE_DEFAULTS;
const instr = (cfg: Config): ReplyInstructions => ({ ...STAGE_DEFAULTS, ...(cfg.reply_instructions ?? {}) });

export type Stage = "answer" | "start" | "gather" | "engage" | "hook" | "quiet";
// A single clarifying round can land badly (e.g. spent reciprocating "how are you" instead of asking about their
// situation) and still leave no real context — one more chance to recover before forcing a real answer regardless.
// The shared prompt (prompt_template.md, FLOW step 2) allows exactly ONE follow-up in the whole chat — "this is
// the only question in the chat." 1, not more: once it's used (or the deterministic "no topic at all" re-ask has
// fired), the next reply is forced forward (a real finding, or falling through to the model) rather than leaving
// a second question to the model's own judgement, which it doesn't reliably apply turn over turn.
const MAX_CLARIFY_ROUNDS = 1;
// Every Nth "engage" reply carries a deliberate doubt-creating line instead of a purely positive one (see doubtDue
// in buildSystemPrompt and reply_instructions.engage_doubt) — 2 positive, 1 doubt, repeating.
const ENGAGE_DOUBT_EVERY = 3;
export function stageFor(L: Loaded, st: SessionState, secondsLeft: number, quiet = false): Exclude<Stage, "quiet"> {
  if (quiet && !st.chartShown) return "start";
  // The very first real message(s): may answer directly (today's "answer" behaviour) or ask its one clarifying
  // question first — see stage "gather" and CLARIFY_MARKER. Once MAX_CLARIFY_ROUNDS has been used, the next
  // reply is forced into a real finding, same as "answer" always was.
  if (!quiet && !st.chartShown && (st.clarifyRounds ?? 0) < MAX_CLARIFY_ROUNDS) return "gather";
  if (!quiet && !st.answered) return "answer";
  return secondsLeft <= L.cfg.timing.pull_until_seconds_left ? "hook" : "engage";
}

export function buildSystemPrompt(
  L: Loaded, ctx: Context, st: SessionState, bubbles = L.cfg.style.max_bubbles, secondsLeft = L.cfg.timing.free_seconds,
  quiet = false,
): string {
  const { cfg } = L;
  const topic = st.currentTopic;
  const stage = stageFor(L, st, secondsLeft, quiet);
  const topicLabel = topic ? TOPIC_LABEL[topic] ?? topic : "their life right now";
  const I = instr(cfg);
  // The fixed, unconditional shape of "engage", by turn count (st.engageTurns, already incremented for THIS turn
  // by the time this runs — see route()/runNudge()) — never dependent on what the user actually says: turn 1 =
  // engage_bridge (the bridge bubble AND the one real question, together — fires on the very first engage reply,
  // never waiting on a second user message for the question), turn 2 = engage_cliffhanger, turn 3 = engage_stall.
  // The same order every chat, every time.
  const engageTurn = stage === "engage" ? (st.engageTurns ?? 0) : 0;
  // Every ENGAGE_DOUBT_EVERYth "engage" turn after the fixed sequence above (2 positive insights, then 1
  // doubt-creating one) — a deliberate rhythm, not left to the model's own pacing, so the conversation keeps
  // leaning toward wanting the full reading rather than feeling resolved along the way.
  const doubtDue = engageTurn > 3 && engageTurn % ENGAGE_DOUBT_EVERY === 0;
  // If the clock forced the switch to "hook" after the engage ladder had already given the cliffhanger or the
  // stalling move (st.engageTurns >= 2), that already left them on an open thread — hook_after_ladder sharpens it
  // in ONE bubble instead of hook's normal two, rather than opening a second one right on top of it.
  const hookAfterLadder = stage === "hook" && (st.engageTurns ?? 0) >= 2;
  // Turns 1-3 are each the ENTIRE reply on their own — the base "engage" reacting+insight instruction is skipped
  // for them, never layered underneath, so the model gets only "do the bridge+question" (or cliffhanger/stall),
  // not "do that AND react AND add an insight". Base "engage" only comes back once the ladder is done (turn 4+).
  const inLadder = engageTurn >= 1 && engageTurn <= 3;
  // engage_bridge's own second bubble is the ONLY question "engage" ever asks — every other engage turn must be
  // told not to ask one, since nothing else in the prompt forbids it on a specific turn (the global "ask at most
  // one more question" budget alone isn't tight enough: a live test asked on turn 1 before this line was added).
  const thisReply = [
    quiet ? I.quiet : "",
    stage === "start" ? I.start.replace("{topic}", topicLabel)
      : stage === "hook" && hookAfterLadder ? I.hook_after_ladder
      : stage === "engage" && inLadder ? ""
      : I[stage],
    engageTurn === 1 ? I.engage_bridge : "",
    engageTurn === 2 ? I.engage_cliffhanger : "",
    engageTurn === 3 ? I.engage_stall : "",
    stage === "engage" && engageTurn !== 1 ? "Don't ask a question in this reply." : "",
    doubtDue ? I.engage_doubt : "",
  ].filter(Boolean).join(" ");
  const insight = render(cfg.insight_levels[ctx.insightLevel], {
    window_for_topic: (topic && ctx.user.windows?.[topic]) || "",
  });
  return render(L.template, {
    ...ctx.vars,
    prompt_version: cfg.experiment.prompt_version,
    arm_id: ctx.arm.id,
    persona_name: cfg.persona.name,
    persona_voice: render(cfg.persona.voice, ctx.vars),
    free_minutes: String(Math.round(cfg.timing.free_seconds / 60)),
    insight_instructions: insight,
    user_facts: userFacts(cfg, ctx, topic),
    address: [
      ctx.vars.name ? `Say "aap" and call them "${ctx.vars.name} ji".` : `Say "aap". Their name isn't known: never guess one.`,
      ctx.vars.gender === "unknown"
        ? `Their gender isn't known: never use a gender-specific word form — use the neutral, respectful default instead ` +
          `(e.g. in Hindi, "kaise" rather than "kaisa"/"kaisi"), in whichever language you're replying in.`
        : "",
    ].filter(Boolean).join(" "),
    lagna_line: "",
    current_topic_label: topic ? TOPIC_LABEL[topic] ?? topic : "not told yet",
    last_summary_line: (cfg.assets?.last_chat !== false && ctx.user.last_summary?.trim()) || "none",
    monthly_line_block: cfg.monthly_line ? `\n- This month: ${render(cfg.monthly_line, ctx.vars)}` : "",
    max_bubbles: String(bubbles),
    max_words: String(cfg.style.max_words_per_bubble),
    separator: cfg.style.separator,
    questions_left: String(Math.max(0, cfg.style.question_budget - st.questionsAsked)),
    disclosure_line: render(cfg.persona.disclosure_line, ctx.vars),
    this_reply: thisReply,
  });
}

/** What we know about the user, one line each. Anything unknown is left out, or marked "don't mention" if the model might guess. */
function userFacts(cfg: Config, ctx: Context, topic: string | null): string {
  const u = ctx.user, v = ctx.vars;
  const tobKnown = !!u.tob?.trim();
  const lines = [
    [v.name && `Name: ${v.name}`, v.gender !== "unknown" && `gender: ${v.gender}`, v.age_band !== "unknown" && `age: ${v.age_band}`]
      .filter(Boolean).join(" · "),
    u.moon_certain === false ? "Rashi: not certain (no birth time). Don't name a rashi." : `Chandra rashi: ${u.moon_sign}`,
    u.dasha_certain === false ? "Dasha: not certain (no birth time). Don't name a dasha." : `Mahadasha / antardasha: ${u.mahadasha} / ${u.antardasha}`,
    tobKnown && u.lagna ? `Lagna: ${u.lagna}` : "Lagna: unknown. Don't mention lagna or house numbers.",
    topic ? `They care about: ${TOPIC_LABEL[topic] ?? topic}` : "",
    cfg.assets?.last_chat !== false && u.last_summary?.trim() ? `Last chat with us: ${u.last_summary.trim()}` : "",
    u.last_consult_date || u.consult_count ? `Returning user: last consult ${v.lapsed_days_band}, consults so far ${v.consult_count_band}` : "",
    `Local time: ${v.time_of_day}`,
    cfg.monthly_line ? `This month: ${render(cfg.monthly_line, v)}` : "",
  ];
  return lines.filter(Boolean).map((l) => `- ${l}`).join("\n");
}

function knownTopicKey(cfg: Config, ctx: Context): string | null {
  return ctx.user.last_topic && cfg.scripted.topic_hook[ctx.user.last_topic] ? ctx.user.last_topic : null;
}

// opening[0] ("Namaste {name} ji") either way; opening[1] ("Aapka swagat hai.") when the topic isn't known yet,
// returning_greeting ("Kaise hai aap?") for a returning user whose topic is already known. The actual topic
// question is no longer bundled in here — see topicPromptLine() and timing.topic_wait_seconds.
export function openingBubbles(cfg: Config, ctx: Context): string[] {
  const line2 = knownTopicKey(cfg, ctx) ? cfg.scripted.returning_greeting : cfg.scripted.opening[1];
  return [cfg.scripted.opening[0], line2].map((l) => say(l, ctx.vars));
}

/** The question asked once timing.topic_wait_seconds has passed with nothing said: their own predefined topic
 *  question if it's already known, else the generic topic_prompt. Scripted — no model call. */
export function topicPromptLine(cfg: Config, ctx: Context, st?: SessionState): string {
  // A topic the user has already named THIS session (st.currentTopic) always wins over the profile's stale
  // last_topic — otherwise a fallback line can ignore what they just said and ask about an old, unrelated topic
  // (or the generic line, if the profile has none at all), which reads as not having listened at all.
  const named = st?.currentTopic && cfg.scripted.topic_hook[st.currentTopic] ? st.currentTopic : null;
  const known = named ?? knownTopicKey(cfg, ctx);
  return say(known ? cfg.scripted.topic_hook[known] : cfg.scripted.topic_prompt, ctx.vars);
}

/** Stage "gather"'s own fallback, when its LLM call fails AFTER a topic is already known: topic_hook ("Naukri ke
 *  baare mein jaanna hai?") is a yes/no topic CONFIRMATION, not a real clarifying follow-up — reusing it here reads
 *  as if Omkar didn't actually take in what they said. topic_followup asks what's actually going on instead, same
 *  as the model itself is told to ask. Falls back to topicPromptLine when the topic truly isn't known yet (nothing
 *  to follow up ON), or when a language hasn't been given its own topic_followup lines. */
export function gatherFollowupLine(cfg: Config, ctx: Context, st?: SessionState): string {
  const topic = st?.currentTopic && cfg.scripted.topic_hook[st.currentTopic] ? st.currentTopic : knownTopicKey(cfg, ctx);
  const line = topic ? cfg.scripted.topic_followup?.[topic] : undefined;
  return line ? say(line, ctx.vars) : topicPromptLine(cfg, ctx, st);
}

/** The line sent with the kundli card, just before the first answer. */
/** "Aapki kundli dekh raha hoon…" before the kundli card, like an astrologer opening the chart. "" = off. */
export function chartIntro(cfg: Config, ctx: Context): string {
  return cfg.scripted.chart_intro ? say(cfg.scripted.chart_intro, ctx.vars) : "";
}

export function chartLine(cfg: Config, ctx: Context, topic: string | null): string {
  // Only name the dasha when we're sure of it; otherwise a positive line tied to THEIR topic (never a generic
  // "something good is happening") — same place, same pacing — so the reveal never goes quiet here and never
  // names a specific planet/dasha we're not sure is right.
  if (ctx.user.moon_certain === false || ctx.user.dasha_certain === false) {
    const unsure = cfg.scripted.chart_line_unsure;
    return say((topic && unsure[topic]) || unsure.default, ctx.vars);
  }
  return say(cfg.scripted.chart_line, ctx.vars);
}

export function closingBubbles(cfg: Config, ctx: Context): string[] {
  return cfg.scripted.closing.map((l) => say(l, ctx.vars));
}

export function uiText(cfg: Config, ctx: Context): Record<string, string> {
  return Object.fromEntries(Object.entries(cfg.ui).map(([k, v]) => [k, say(v, ctx.vars)]));
}

/** The hand-off card line, naming the topic the user actually talked about (falls back to ui.card_text). */
export function cardText(cfg: Config, ctx: Context, topic: string | null): string {
  const byTopic = topic ? cfg.card_text_by_topic?.[topic] : undefined;
  return say(byTopic ?? cfg.ui.card_text, ctx.vars);
}

/** Where the CTA goes: straight into a chat if they have balance, otherwise recharge first. Carries attribution. */
export function handoffUrl(L: Loaded, token: string, user?: Pick<UserInput, "cohort" | "wallet_balance">): string {
  const hasBalance = Number(user?.wallet_balance ?? 0) > 0;
  const base = hasBalance ? L.cfg.handoff.deeplink_with_balance : L.cfg.handoff.deeplink_no_balance;
  // App links go out exactly as given unless the app is known to accept extra parameters (taps are tracked by our events).
  if (!/^https:\/\//.test(base) && !L.cfg.handoff.utm_on_app_links) return base;
  const utm = render(L.cfg.handoff.utm, {
    token: encodeURIComponent(token), prompt_version: encodeURIComponent(L.cfg.experiment.prompt_version),
    cohort: encodeURIComponent(cohortOf(L.cfg, user ?? {})), arm: encodeURIComponent(assignArm(L.cfg, token).id),
    balance: hasBalance ? "yes" : "no",
  });
  return base + (base.includes("?") ? "&" : "?") + utm;
}

/** Where to send a user whose phone didn't open the app link (app not installed). "" for web links. */
export function fallbackUrl(L: Loaded): string {
  return L.cfg.handoff.fallback_url ?? "";
}

// ── Routing a user message ───────────────────────────────────────────────────

export type Route =
  | { kind: "crisis"; bubbles: string[] }
  | { kind: "ai_question"; bubbles: string[] }
  | { kind: "health"; bubbles: string[] }
  | { kind: "closing"; bubbles: string[] }
  | { kind: "closed"; bubbles: string[] }
  | { kind: "clarify_topic"; bubbles: string[] }
  | { kind: "llm"; systemPrompt: string; userText: string };

const rx = (p: string) => new RegExp(p, "iu");
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function detectTopic(cfg: Config, text: string): string | null {
  for (const [topic, words] of Object.entries(cfg.topics))
    if (words.some((w) => new RegExp(`\\b${escapeRx(w)}\\b`, "iu").test(text))) return topic;
  return null;
}

export const MAX_USER_CHARS = 500;

export function route(
  L: Loaded, ctx: Context, st: SessionState, userText: string, secondsLeft: number, bubbles = L.cfg.style.max_bubbles,
): Route {
  const { cfg } = L;
  const text = (userText || "").slice(0, MAX_USER_CHARS);
  if (st.closed) return { kind: "closed", bubbles: [] };
  if (cfg.guardrails.crisis.some((p) => rx(p).test(text))) {
    st.crisis = true; st.closed = true;
    return { kind: "crisis", bubbles: cfg.scripted.crisis_reply.map((l) => say(l, ctx.vars)) };
  }
  if (secondsLeft <= cfg.timing.closing_at_seconds_left) {
    st.closed = true;
    return { kind: "closing", bubbles: closingBubbles(cfg, ctx) };
  }
  if (cfg.guardrails.ai_question.some((p) => rx(p).test(text)))
    return { kind: "ai_question", bubbles: [say(cfg.persona.disclosure_line, ctx.vars)] };
  const topic = detectTopic(cfg, text);
  if (topic) { st.currentTopic = topic; st.topicNamedByUser = true; }
  if (topic === "sehat") return { kind: "health", bubbles: [say(cfg.scripted.health_reply, ctx.vars)] };
  // Before the first real answer, a message with no topic at all (a bare greeting, "how are you", small talk) is
  // the one case clear enough to decide without the model — which has occasionally answered anyway despite the
  // prompt. Ask the topic question again, deterministically, instead of leaving it to the model's judgement.
  // Gated on topicNamedByUser, not just this message's own topic: once they've named a topic themselves, a later
  // reply that doesn't happen to repeat the word (e.g. "lag nahi rahi" answering "naukri mein kya dikkat hai?")
  // must not be treated as if nothing has been said at all — that's the model's judgement call to make from here.
  if (!st.chartShown && !topic && !st.topicNamedByUser && (st.noTopicRounds ?? 0) < MAX_CLARIFY_ROUNDS) {
    st.noTopicRounds = (st.noTopicRounds ?? 0) + 1;
    return { kind: "clarify_topic", bubbles: [topicPromptLine(cfg, ctx)] };
  }
  // The doubt-rhythm cadence (see ENGAGE_DOUBT_EVERY) counts turns, not successes — committed here, before the
  // model is even called, so a failed/guard-rejected reply still advances it instead of silently resetting the
  // count and letting the rhythm drift or never fire.
  if (stageFor(L, st, secondsLeft) === "engage") st.engageTurns = (st.engageTurns ?? 0) + 1;
  // Injection attempts still go to the model (the prompt tells it to ignore them); the reply guard is the backstop.
  return { kind: "llm", systemPrompt: buildSystemPrompt(L, ctx, st, bubbles, secondsLeft), userText: text };
}

// ── Reply guard ──────────────────────────────────────────────────────────────

const RASHIS: Record<string, string[]> = {
  mesh: ["mesh", "aries"], vrishabh: ["vrishabh", "vrish", "taurus"], mithun: ["mithun"], kark: ["kark", "cancer"],
  singh: ["simha", "leo"], kanya: ["kanya", "virgo"], tula: ["tula", "libra"], vrishchik: ["vrishchik", "scorpio"],
  dhanu: ["dhanu", "sagittarius"], makar: ["makar", "capricorn"], kumbh: ["kumbh", "aquarius"], meen: ["meen", "pisces"],
};
const PLANETS: Record<string, string[]> = {
  shani: ["shani", "saturn"], guru: ["guru", "brihaspati", "jupiter"], shukra: ["shukra", "venus"],
  mangal: ["mangal", "mars"], budh: ["budh", "mercury"], surya: ["surya", "sun"], chandra: ["chandra", "moon"],
  rahu: ["rahu"], ketu: ["ketu"],
};
const canon = (table: Record<string, string[]>, word: string) =>
  Object.keys(table).find((k) => k === word.toLowerCase() || table[k].includes(word.toLowerCase())) ?? null;

export function bannedHit(cfg: Config, bubble: string, allow: string[] = []): string | null {
  for (const b of cfg.guardrails.banned) if (!allow.includes(b.reason) && rx(b.pattern).test(bubble)) return b.reason;
  return null;
}

function chartFactHit(ctx: Context, bubble: string): string | null {
  const lower = bubble.toLowerCase();
  const userRashi = ctx.user.moon_certain === false ? "" : canon(RASHIS, ctx.user.moon_sign) ?? ctx.user.moon_sign.toLowerCase();
  if (/rashi|sign/.test(lower))
    for (const [k, names] of Object.entries(RASHIS))
      if (k !== userRashi && names.some((n) => new RegExp(`\\b${n}\\b`, "iu").test(lower))) return "wrong_rashi";
  const sure = ctx.user.dasha_certain !== false;
  const maha = sure ? canon(PLANETS, ctx.user.mahadasha) : null, antar = sure ? canon(PLANETS, ctx.user.antardasha) : null;
  // "Surya dasha", "Guru ki mahadasha", "Rahu ka antardasha", "mahadasha Shani ki": a planet named next to "dasha"
  // must be theirs, and "mahadasha"/"antardasha" must name the right one.
  const near = [
    ...lower.matchAll(/\b([a-z]+)\s+(?:(?:ki|ka|ke)\s+)?(maha|antar)?\s?dasha\b/g),
    ...[...lower.matchAll(/\b(maha|antar)?dasha\s+([a-z]+)\b/g)].map((m) => [m[0], m[2], m[1]] as unknown as RegExpMatchArray),
  ];
  for (const m of near) {
    const p = canon(PLANETS, m[1]);
    if (!p) continue;
    const ok = m[2] === "maha" ? p === maha : m[2] === "antar" ? p === antar : p === maha || p === antar;
    if (!ok) return "wrong_dasha";
  }
  // Two different planets/dashas named in one bubble ("Shani aur Ketu ka asar", "Mangal ki mahadasha mein Budh ki
  // antardasha") reads as jargon-stacking — the prompt asks for exactly one per bubble, but the model doesn't
  // reliably hold to it, so this is the backstop: count every distinct planet actually named in the bubble.
  const namedPlanets = new Set<string>();
  for (const [planet, names] of Object.entries(PLANETS))
    if (names.some((n) => new RegExp(`\\b${n}\\b`, "iu").test(lower))) namedPlanets.add(planet);
  if (namedPlanets.size >= 2) return "stacked_terms";
  return null;
}

export type Guarded = { bubbles: string[]; flags: string[]; questions: number };

const DANGLING = /(,|\b(par|lekin|magar|aur|ki|ke|ka|ko|mein|se|toh|to))\s*$/i;
const sameLine = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

export function guardReply(
  L: Loaded, ctx: Context, st: SessionState, raw: string, maxBubbles = L.cfg.style.max_bubbles,
  previous: string[] = [], // Omkar's earlier lines in this chat: never say the same thing twice
): Guarded {
  const said = new Set(previous.map(sameLine));
  const { cfg } = L;
  const flags: string[] = [];
  const parts = String(raw ?? "")
    .split(cfg.style.separator).flatMap((p) => p.split(/\n+/))
    .map((p) => p.replace(/^[\s"'*\-•]+|[\s"'*]+$/g, "").replace(/\s+/g, " "))
    .filter((p) => p.length > 0)
    // A bubble cut mid-sentence ("Yog hain, par") is joined with the next one, never shown hanging.
    .reduce<string[]>((acc, p) => {
      const prev = acc[acc.length - 1];
      if (prev !== undefined && DANGLING.test(prev)) acc[acc.length - 1] = `${prev} ${p}`;
      else acc.push(p);
      return acc;
    }, []);

  const kept: string[] = [];
  let questions = 0;
  for (const p of parts) {
    const ban = bannedHit(cfg, p, ctx.arm.allow ?? []);
    if (ban) { flags.push(`dropped:${ban}`); continue; }
    const fact = chartFactHit(ctx, p);
    if (fact) { flags.push(`dropped:${fact}`); continue; }
    if (said.has(sameLine(p))) { flags.push("dropped:repeat"); continue; }
    said.add(sameLine(p));
    const words = p.split(" ").length;
    // Up to max_words_per_bubble: clean. Past that: kept but flagged — long_bubble (a modest overrun, room for a
    // sentence that genuinely needs it) or very_long_bubble (pacing.long_bubble_words+, e.g. two ideas packed into
    // one bubble) — never dropped: the client paces a very_long_bubble with a longer typing time
    // (pacing.long_bubble_typing_ms) instead of losing it outright.
    if (words >= cfg.pacing.long_bubble_words) flags.push("very_long_bubble");
    else if (words > cfg.style.max_words_per_bubble) flags.push("long_bubble");
    const isQuestion = /\?\s*$/.test(p);
    if (isQuestion && st.questionsAsked + questions >= cfg.style.question_budget) { flags.push("dropped:question_over_budget"); continue; }
    if (isQuestion && questions >= 1) { flags.push("dropped:second_question"); continue; } // one question per reply, like a person
    if (isQuestion) questions++;
    kept.push(p);
    if (kept.length === maxBubbles) { if (parts.length > kept.length) flags.push("trimmed_extra_bubbles"); break; }
  }
  return { bubbles: kept, flags, questions };
}

// ── One full turn: routing, timeout, guard, one retry, fallback ──────────────

export type LLMFn = (args: {
  system: string; messages: ChatMessage[]; model: Config["model"]; timeoutMs: number;
}) => Promise<string>;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

export const HISTORY_TURNS = 8; // messages of history sent to the model

export type LLMFnArgs = Parameters<LLMFn>[0];

/** Calls the model, guards the reply, retries once, and falls back to a safe line. Updates the log and question count. */
async function generate(
  L: Loaded, ctx: Context, st: SessionState, system: string, messages: ChatMessage[], llm: LLMFn,
  bubbles: number, previous: string[], log: TurnLog, stage: Stage,
): Promise<string[]> {
  const { cfg } = L;
  // Mirrors buildSystemPrompt's hookAfterLadder: the ladder already left them on an open thread (the cliffhanger
  // or the stall), so hook_after_ladder's ONE bubble is enforced here too, not just asked for in the prompt.
  if (stage === "hook" && (st.engageTurns ?? 0) >= 2) bubbles = 1;
  // engage_bridge is exactly TWO bubbles (the bridge line + the one real question) — enforced here too, so a
  // model that writes a stray third bubble never gets it shown.
  if (stage === "engage" && (st.engageTurns ?? 0) === 1) bubbles = 2;
  // secondsLeft() (src/lib/chat.ts) subtracts st.llmWaitMs from the elapsed wall-clock time, so a slow or failing
  // model call never silently eats into the user's free_seconds — every attempt (success, retry, or eventual
  // timeout) is measured here and added regardless of outcome. This is what makes a generous llm_timeout_ms safe.
  const call = async (sys: string) => {
    const started = Date.now();
    try {
      return await withTimeout(llm({ system: sys, messages, model: cfg.model, timeoutMs: cfg.timing.llm_timeout_ms }), cfg.timing.llm_timeout_ms);
    } finally {
      st.llmWaitMs = (st.llmWaitMs ?? 0) + (Date.now() - started);
    }
  };
  // A timeout or a genuine API error must never fall back to the generic line just because the model was slow or
  // briefly erroring — llmWaitMs (above) already keeps retries from costing the user any of their free_seconds, so
  // there's no downside to trying again. Only a call that fails CALL_ATTEMPTS times in a row (e.g. the API is
  // genuinely down) ever reaches the fallback path below. This is independent of the guard-rejection retry further
  // down (that one resends with different wording because the CONTENT broke a rule, not because the call failed).
  const CALL_ATTEMPTS = 3;
  const callResilient = async (sys: string) => {
    for (let i = 1; i <= CALL_ATTEMPTS; i++) {
      try {
        return await call(sys);
      } catch (err) {
        log.flags.push((err as Error).message === "timeout" ? "llm_timeout" : "llm_error");
        if (i === CALL_ATTEMPTS) throw err;
      }
    }
    throw new Error("unreachable");
  };
  // Stage "gather" may open with CLARIFY_MARKER instead of answering — strip it before the normal bubble/guard
  // pipeline ever sees it, and remember that this turn asked a question rather than giving the real answer.
  const unmark = (raw: string) => {
    const t = raw.trimStart();
    const clarifying = stage === "gather" && t.startsWith(CLARIFY_MARKER);
    return { text: clarifying ? t.slice(CLARIFY_MARKER.length) : raw, clarifying };
  };
  try {
    let first = unmark(await callResilient(system));
    let g = guardReply(L, ctx, st, first.text, first.clarifying ? 1 : bubbles, previous);
    log.flags.push(...g.flags);
    let clarifying = first.clarifying;
    if (g.bubbles.length === 0) {
      log.retried = true;
      const why = [...new Set(g.flags.map((f) => f.replace("dropped:", "")))].join(", ") || "empty reply";
      first = unmark(await callResilient(
        system + `\n\nYour last reply broke the rules (${why}). Reply again, shorter, following every rule.`,
      ));
      g = guardReply(L, ctx, st, first.text, first.clarifying ? 1 : bubbles, previous);
      clarifying = first.clarifying;
      log.flags.push(...g.flags.map((f) => `retry_${f}`));
    }
    if (g.bubbles.length > 0) {
      st.questionsAsked += g.questions;
      st.lastAsked = g.questions > 0;
      if (stage === "answer") st.answered = true;
      if (stage === "gather") { if (clarifying) st.clarifyRounds = (st.clarifyRounds ?? 0) + 1; else st.answered = true; }
      if (stage === "hook") st.hooked = true;
      log.clarifying = clarifying;
      return g.bubbles;
    }
  } catch {
    // callResilient already logged a flag for every failed attempt, including this final one.
  }
  log.used_fallback = true;
  st.lastAsked = false;
  // A failed/guard-rejected "gather" call must never fall through to a generic line with the kundli attached —
  // we still have no idea what they want. Ask a real follow-up instead (never reveal without it) — gatherFollowupLine
  // prefers the topic they just named THIS turn (st.currentTopic) over a stale profile last_topic, and asks what's
  // actually going on rather than reusing the yes/no topic-confirmation line, which reads as not having listened.
  if (stage === "gather") {
    st.clarifyRounds = (st.clarifyRounds ?? 0) + 1;
    log.clarifying = true;
    const line = gatherFollowupLine(cfg, ctx, st);
    // The topic question may already have gone out once (route()'s own deterministic clarify_topic, or an
    // earlier gather fallback) — Omkar must never say the exact same line twice in one chat, so fall through
    // to the ordinary doubt-hook fallback instead of asking the identical question again.
    if (previous.some((p) => sameLine(p) === sameLine(line))) return [fallbackLine(cfg, ctx, previous)];
    return [line];
  }
  // A failed "answer" call must still move the conversation forward — without this, a repeatedly failing model
  // call leaves st.answered unset forever, stageFor() keeps forcing "answer" again next turn, and the user sees
  // the exact same fallback_reply line on every single turn with no way out (the bug: this used to loop forever).
  if (stage === "answer") st.answered = true;
  return [fallbackLine(cfg, ctx, previous)];
}

// The generic doubt-hook fallback (any stage but "gather" failing/guard-rejected): never say the exact same line
// twice in one chat. fallback_reply_alt is the one swap available — if that's ALSO already been said (a third
// failure), there's nothing left to vary with, so it repeats as a last resort rather than showing nothing at all.
function fallbackLine(cfg: Config, ctx: Context, previous: string[]): string {
  const primary = say(cfg.scripted.fallback_reply, ctx.vars);
  if (!previous.some((p) => sameLine(p) === sameLine(primary))) return primary;
  return cfg.scripted.fallback_reply_alt ? say(cfg.scripted.fallback_reply_alt, ctx.vars) : primary;
}

function newLog(L: Loaded, ctx: Context, st: SessionState, route: string, userText: string, secondsLeft: number): TurnLog {
  const { cfg } = L;
  return {
    session_token: ctx.user.token, experiment_id: cfg.experiment.id, arm: ctx.arm.id,
    prompt_version: cfg.experiment.prompt_version, config_hash: L.configHash, model: cfg.model.name,
    turn: st.turns, seconds_left: secondsLeft, route, user_text: userText.slice(0, MAX_USER_CHARS), cohort: ctx.vars.cohort,
    bubbles: [], flags: [], latency_ms: null, used_fallback: false, retried: false, show_handoff: false, clarifying: false,
    ladder_turn: 0,
  };
}

export async function runTurn(
  L: Loaded, ctx: Context, st: SessionState, userText: string, secondsLeft: number, llm: LLMFn,
  history: ChatMessage[] = [], bubbles = L.cfg.style.max_bubbles,
): Promise<{ bubbles: string[]; showHandoff: boolean; log: TurnLog }> {
  const { cfg } = L;
  st.turns++;
  const started = Date.now();
  const r = route(L, ctx, st, userText, secondsLeft, bubbles);
  const log = newLog(L, ctx, st, r.kind, userText, secondsLeft);
  const stage = stageFor(L, st, secondsLeft);
  log.ladder_turn = stage === "engage" ? (st.engageTurns ?? 0) : 0;
  const out = r.kind !== "llm"
    ? r.bubbles
    : await generate(L, ctx, st, r.systemPrompt, [...history.slice(-HISTORY_TURNS), { role: "user", text: r.userText }], llm,
      bubbles, history.filter((m) => m.role === "ai").map((m) => m.text), log, stage);
  if (r.kind === "clarify_topic") log.clarifying = true;
  log.latency_ms = Date.now() - started;
  log.bubbles = out;
  // Never show the sales card to someone in distress.
  log.show_handoff = !st.crisis && secondsLeft <= cfg.timing.handoff_card_at_seconds_left;
  return { bubbles: out, showHandoff: log.show_handoff, log };
}

// The model needs a user turn to reply to; this stands in for silence and is never stored or shown.
export const QUIET_MARKER = "(…)";

/**
 * The user has gone quiet: Omkar carries on by himself (or, near the end, sends the closing lines).
 * Nothing is sent after the chat is closed or to someone in distress.
 */
export async function runNudge(
  L: Loaded, ctx: Context, st: SessionState, secondsLeft: number, llm: LLMFn,
  history: ChatMessage[] = [], bubbles = L.cfg.style.max_bubbles,
): Promise<{ bubbles: string[]; log: TurnLog }> {
  st.turns++;
  const started = Date.now();
  if (st.closed || st.crisis) return { bubbles: [], log: newLog(L, ctx, st, "closed", "", secondsLeft) };
  if (secondsLeft <= L.cfg.timing.closing_at_seconds_left) {
    st.closed = true;
    const log = newLog(L, ctx, st, "closing_quiet", "", secondsLeft);
    // If Omkar already left them on an open thread, a second one would read as a script: just close.
    log.bubbles = st.hooked ? [] : closingBubbles(L.cfg, ctx);
    return { bubbles: log.bubbles, log };
  }
  const log = newLog(L, ctx, st, "quiet", "", secondsLeft);
  // Same unconditional counting as route() — a quiet-triggered reply that resolves to "engage" still advances
  // the doubt-rhythm cadence, whether or not the model call itself succeeds.
  if (stageFor(L, st, secondsLeft, true) === "engage") st.engageTurns = (st.engageTurns ?? 0) + 1;
  log.ladder_turn = stageFor(L, st, secondsLeft, true) === "engage" ? (st.engageTurns ?? 0) : 0;
  const out = await generate(
    L, ctx, st, buildSystemPrompt(L, ctx, st, bubbles, secondsLeft, true),
    [...history.slice(-HISTORY_TURNS), { role: "user", text: QUIET_MARKER }], llm,
    bubbles, history.filter((m) => m.role === "ai").map((m) => m.text), log, stageFor(L, st, secondsLeft, true),
  );
  log.latency_ms = Date.now() - started;
  log.bubbles = out;
  return { bubbles: out, log };
}

/** 2–3 bubbles, like a person: the first answer is short, the next few replies are full, then it varies. */
export function bubblesFor(L: Loaded, st: SessionState, token: string): number {
  const { style } = L.cfg;
  if (!st.chartShown) return style.first_answer_bubbles;
  const replies = st.turns - 1; // replies after the first answer (st.turns counts the first answer too)
  if (replies < style.early_replies) return style.max_bubbles;
  const pick = createHash("sha256").update(`${token}:${st.turns}`).digest().readUInt32BE(0);
  return style.later_bubbles[pick % style.later_bubbles.length];
}

