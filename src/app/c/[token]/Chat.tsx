"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import s from "./chat.module.css";
import Confetti from "./Confetti";
import { KundliCard } from "./Kundli";
import type { KundliView } from "./Kundli";

type Msg = { role: "user" | "ai" | "kundli" | "details" | "system"; text: string; at?: string };
type View = {
  status: "invalid" | "active" | "ended" | "choose_language";
  languageOptions: { key: string; label: string }[];
  languagePrompt: string;
  brandName: string;
  brandLogo: string;
  onboardingLabels: Record<string, Partial<typeof DEFAULT_ONBOARD_LABELS>>;
  justStarted: boolean;
  clockStarted: boolean;
  ui: Record<string, string>;
  persona: { name: string; label: string; avatar: string; verified: boolean };
  messages: Msg[];
  secondsLeft: number;
  freeSeconds: number;
  idleNudgeSeconds: number;
  topicWaitTypingSeconds: number;
  topicWaitSeconds: number;
  topicAsked: boolean;
  closingAt: number;
  handoffAt: number;
  ctaCountdown: number;
  handoffUrl: string;
  fallbackUrl: string;
  closed: boolean;
  crisis: boolean;
  chart: { moonSign: string; mahadasha: string; antardasha: string; kundli: KundliView | null } | null;
  pacing: {
    read_delay_ms: number; typing_min_ms: number; typing_ms_per_char: number; typing_max_ms: number;
    between_messages_ms: number; system_note_ms: number; kundli_gap_ms: number; kundli_ms: number;
    post_kundli_gap_ms: number; post_kundli_typing_ms: number; dramatic_gap_ms: number;
    long_bubble_words: number; long_bubble_typing_ms: number;
  };
  canRestart: boolean;
  promptVersion: string;
  // The "engage" ladder turn the next user message will trigger (0 = n/a) — see src/lib/chat.ts View.upcomingEngageTurn.
  upcomingEngageTurn: number;
};
// ladderTurn: this reply's SessionState.engageTurns — 1-3 means it's part of the fixed engage_bridge (the bridge
// bubble AND the one real question, together) / engage_cliffhanger / engage_stall sequence, paced slowly like the
// kundli reveal instead of the usual length-based timing.
// chartLineIndex: position of the chart_line bubble when this reply is the first-answer kundli reveal — paced
// slowly throughout whether or not the card itself is present (no birth time skips the card, never the pacing).
type SendResult = { ok: boolean; error?: string; messages?: Msg[]; view: View; ladderTurn?: number; chartLineIndex?: number | null };

// Message pacing comes from config.yaml → pacing (sent with the view). These are only used before it arrives.
const DEFAULT_PACING: View["pacing"] = {
  read_delay_ms: 600, typing_min_ms: 800, typing_ms_per_char: 25, typing_max_ms: 1800,
  between_messages_ms: 350, system_note_ms: 1100, kundli_gap_ms: 2500, kundli_ms: 2500,
  post_kundli_gap_ms: 2500, post_kundli_typing_ms: 2500, dramatic_gap_ms: 5000,
  long_bubble_words: 18, long_bubble_typing_ms: 7500,
};
// A bubble this long is never dropped by the guard any more — it's kept and shown, just typed out slower so it
// still reads as a deliberate, considered reply rather than an unnaturally fast one for how much it says.
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const TICK_MS = 100;       // timer resolution (drives the smooth bars)
const HANDOFF_TYPING_MS = 1800; // Omkar "types" for a beat right as the clock runs out, before the hand-off card appears

// "typing…" lasts longer for longer messages, like a person typing, within min..max.
const typingMs = (p: View["pacing"], text: string) =>
  Math.min(p.typing_max_ms, Math.max(p.typing_min_ms, p.typing_min_ms + text.length * p.typing_ms_per_char - 200));

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as T;
}

// Opens the app. For an app link (astrolokal://…): if the page is still showing after 1.5 s, the app didn't open
// (usually not installed), so go to the fallback (the Play Store). Web links open normally.
function openApp(e: { preventDefault(): void } | null, url: string, fallback: string) {
  if (/^https?:\/\//i.test(url) || !fallback) return; // a normal link: let the browser follow it
  e?.preventDefault();
  let left = false;
  const onHide = () => { if (document.visibilityState === "hidden") left = true; };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  window.location.href = url;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (!left && document.visibilityState === "visible") window.location.href = fallback;
  }, 1500);
}

function beacon(token: string, name: string, props: Record<string, unknown> = {}) {
  const body = JSON.stringify({ token, name, props });
  try {
    if (navigator.sendBeacon?.("/api/event", body)) return;
  } catch { /* fall through */ }
  void fetch("/api/event", { method: "POST", body, keepalive: true }).catch(() => undefined);
}


const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec) % 60).padStart(2, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const buzz = () => { try { navigator.vibrate?.(12); } catch { /* not supported */ } };

export default function Chat({ token }: { token: string }) {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [shown, setShown] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msLeft, setMsLeft] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [cardAt, setCardAt] = useState<number | null>(null); // when the hand-off card appeared (starts the button countdown)
  const [cardVisible, setCardVisible] = useState(false); // the card itself, shown only after the typing beat below
  const [now, setNow] = useState(0);
  const [pickingLang, setPickingLang] = useState(false);
  // When the opening greeting finished revealing (or a resumed chat loaded) — the reference point for the
  // post-greeting wait, before Omkar proactively asks the topic question. State, not a ref: it's set inside an
  // async .then(), and the watcher effect below needs to re-run once that actually lands.
  const [topicWaitStart, setTopicWaitStart] = useState<number | null>(null);

  const endsAt = useRef<number | null>(null); // null until the first message starts the clock
  const cardLogged = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pacing = useRef<View["pacing"]>(DEFAULT_PACING);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const userScrollAt = useRef(0);
  const msLeftRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false); // synchronous guard: state updates are too slow to stop a double tap
  const revealing = useRef(0);     // messages still being revealed
  const nudging = useRef(false);
  const closingAsked = useRef(false);
  const lastActivity = useRef(0); // last message shown or key pressed (set when the chat opens): Omkar speaks up after a quiet spell
  const draftRef = useRef("");

  const sync = useCallback((v: View) => {
    setView(v);
    if (v.pacing) pacing.current = v.pacing;
    endsAt.current = v.clockStarted ? Date.now() + v.secondsLeft * 1000 : null;
    msLeftRef.current = v.secondsLeft * 1000;
    setMsLeft(msLeftRef.current);
  }, []);

  // Messages are revealed through one queue, so a reply never interleaves with another.
  // firstAlreadyTyped: the typing dots were already showing while we waited for the server.
  // typedSince: when those dots appeared; the first message still gets its full typing time (a fast model
  // reply shouldn't make Omkar answer instantly).
  const reveal = useCallback((msgs: Msg[], typedSince?: number, ladderTurn?: number, chartLineIndex?: number | null) => {
    revealing.current += 1;
    queue.current = queue.current.then(async () => {
      // The whole first-answer reveal (empathy → kundli intro → card? → chart line → finding → hook) and the
      // engage_bridge/engage_cliffhanger/engage_stall turns all run on this same slow, uniform pause-then-type
      // rhythm instead of the usual length-based timing — one deliberate moment, not a quick burst of bubbles.
      // chartLineIndex (non-null) marks a first-answer reveal even when there's no kundli card to detect it from
      // (no birth time skips the card, but never the slow pacing); ladderTurn 1-3 covers the ladder turns, which
      // never carry a card or a chart line at all.
      const inLadder = !!ladderTurn && ladderTurn >= 1 && ladderTurn <= 3;
      const afterKundli = inLadder || chartLineIndex != null || msgs.some((m) => m.role === "kundli");
      for (const [i, m] of msgs.entries()) {
        const p = pacing.current;
        const typed = m.role === "ai" || m.role === "kundli";
        if (typed) {
          setTyping(true);
          const want = m.role !== "kundli" && wordCount(m.text) >= p.long_bubble_words ? p.long_bubble_typing_ms
            : m.role === "kundli" ? p.kundli_ms
            : afterKundli ? p.post_kundli_typing_ms : typingMs(p, m.text);
          await sleep(i === 0 && typedSince ? Math.max(0, want - (Date.now() - typedSince)) : want);
        }
        setTyping(false);
        setShown((prev) => [...prev, m]);
        // The kundli card itself gets its own silent gap before "typing…" starts (pacing.kundli_gap_ms) — a
        // deliberate pause, as if Omkar is genuinely checking the chart. Right before the chart line — whether
        // that's right after the card, or (no card: no birth time) right after the intro line — there's a longer
        // pause still (dramatic_gap_ms). engage_bridge's own two bubbles (the bridge, then the one real question)
        // get that same longer pause between them, for the same reason — the question is the one moment in this
        // phase that should feel weightier. Everything else in these replies shares the uniform post_kundli_gap_ms
        // pause.
        const nextIsKundli = msgs[i + 1]?.role === "kundli";
        const gap = nextIsKundli ? p.kundli_gap_ms
          : m.role === "kundli" || chartLineIndex === i + 1 ? p.dramatic_gap_ms
          : ladderTurn === 1 && i === 0 ? p.dramatic_gap_ms
          : afterKundli ? p.post_kundli_gap_ms
          : m.role === "system" ? p.system_note_ms : p.between_messages_ms;
        await sleep(gap);
      }
    }).finally(() => { revealing.current -= 1; lastActivity.current = Date.now(); });
    return queue.current;
  }, []);

  // The user's tap on the language screen: saves the pick, then opens the chat exactly like the first load would.
  const pickLanguage = useCallback(async (key: string) => {
    if (pickingLang) return;
    setPickingLang(true);
    try {
      const v = await post<View>("/api/language", { token, language: key });
      sync(v);
      lastActivity.current = Date.now();
      if (v.status === "active" || v.status === "ended") {
        beacon(token, v.status === "active" ? "link_opened" : "ended_screen_viewed", { seconds_left: v.secondsLeft });
        if (v.justStarted) await reveal(v.messages);
        else setShown(v.messages);
        setTopicWaitStart(Date.now());
      }
    } catch {
      // let them tap again
    } finally {
      setPickingLang(false);
    }
  }, [token, sync, reveal, pickingLang]);

  // Open or resume the chat.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await post<View>("/api/session", { token });
        if (cancelled) return;
        sync(v);
        lastActivity.current = Date.now();
        if (v.status === "invalid" || v.status === "choose_language") return; // nothing has started yet: no messages, no beacon
        beacon(token, v.status === "active" ? "link_opened" : "ended_screen_viewed", { seconds_left: v.secondsLeft });
        if (v.justStarted) void reveal(v.messages).then(() => setTopicWaitStart(Date.now())); // the opening animates once, never on a reload
        else {
          setShown(v.messages);
          setTopicWaitStart(Date.now());
          requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
        }
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token, sync, reveal]);

  // Clock: runs only after the first message; the server's number is the truth, this just displays it.
  const clockRunning = !!view?.clockStarted && view.status !== "invalid";
  useEffect(() => {
    if (!clockRunning) return;
    const id = setInterval(() => {
      if (endsAt.current === null) return;
      const ms = Math.max(0, endsAt.current - Date.now());
      msLeftRef.current = ms;
      setMsLeft(ms);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [clockRunning]);

  // Keep the newest message in view, unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown, typing]);

  const left = Math.ceil(msLeft / 1000);
  const crisis = !!view?.crisis;
  const active = !!view && view.status !== "invalid";
  const timeUp = left <= 0;
  const locked = !view || view.closed || timeUp;   // input closed
  const showSheet = active && !crisis && !!view?.clockStarted && (left <= view.handoffAt || view.closed);
  const urgent = active && !!view?.clockStarted && !timeUp && left <= view.closingAt;

  // Omkar "types" for a beat the moment the clock runs out, like he's sending one more message — then the
  // hand-off card appears instead (see .sheet's translucent styling: it reads as that message, unreadable).
  useEffect(() => {
    if (!showSheet || cardLogged.current) return;
    cardLogged.current = true;
    setTyping(true);
    const id = setTimeout(() => {
      setTyping(false);
      const t = Date.now();
      setCardAt(t);
      setNow(t);
      setCardVisible(true);
      buzz();
      beacon(token, "handoff_card_shown", { seconds_left: Math.ceil(msLeftRef.current / 1000) });
    }, HANDOFF_TYPING_MS);
    return () => clearTimeout(id);
  }, [showSheet, token]);

  // Ticks the button countdown (only while it runs).
  useEffect(() => {
    if (!cardAt) return;
    const end = cardAt + (view?.ctaCountdown ?? 5) * 1000;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [cardAt, view?.ctaCountdown]);

  // When the chat area changes size (the sheet opens or grows, the keyboard opens), stay on the newest message.
  const hasList = !!view && view.status !== "invalid";
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasList]);

  // The sheet can cover the last message; keep it visible when the sheet opens.
  useEffect(() => {
    if (!showSheet) return;
    stickToBottom.current = true;
    const toBottom = (behavior: ScrollBehavior) => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior });
    toBottom("smooth");
    const t = setTimeout(() => toBottom("auto"), 650); // settle exactly at the bottom once the sheet is in place
    return () => clearTimeout(t);
  }, [showSheet]);

  // Drop-off: when the user switches away from or closes the page during the free time, note how much time was left.
  // Logged once per visit (the last one counts in analytics); it never interrupts anything.
  const liveChat = active && !crisis && !timeUp;
  useEffect(() => {
    if (!liveChat) return;
    let sent = false;
    const onHide = (e: Event) => {
      if (sent || (e.type === "visibilitychange" && document.visibilityState !== "hidden")) return;
      sent = true;
      beacon(token, "page_hidden", { seconds_left: Math.ceil(msLeftRef.current / 1000) });
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); };
  }, [liveChat, token]);

  // When the user goes quiet, Omkar carries on by himself; at closing time he sends the closing line.
  // The server re-checks the silence, so this timer can't make him talk more than configured.
  const quietWatch = active && !crisis && !!view?.clockStarted && !view.closed;
  useEffect(() => {
    if (!quietWatch || !view) return;
    const idleMs = view.idleNudgeSeconds * 1000;
    const id = setInterval(async () => {
      if (sending.current || nudging.current || revealing.current > 0 || closingAsked.current) return;
      const leftMs = msLeftRef.current;
      if (leftMs <= 0) return;
      const closing = leftMs <= view.closingAt * 1000;
      const quiet = idleMs > 0 && Date.now() - lastActivity.current >= idleMs && !draftRef.current.trim();
      if (!closing && !quiet) return;
      if (closing) closingAsked.current = true;
      nudging.current = true;
      setTyping(true);
      const typedSince = Date.now();
      try {
        const r = await post<SendResult>("/api/nudge", { token });
        if (r.view) sync(r.view);
        if (r.ok && r.messages?.length) await reveal(r.messages, typedSince, r.ladderTurn, r.chartLineIndex);
        else setTyping(false);
      } catch {
        setTyping(false);
      } finally {
        lastActivity.current = Date.now();
        nudging.current = false;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [quietWatch, view, token, sync, reveal]);

  // The pause right after the opening greeting: if they haven't said anything by topicWaitSeconds, Omkar
  // proactively asks his topic question (their own, if known, else the generic one) — scripted, server-decided.
  // Stops for good the moment they say anything at all (view.topicAsked, or chartShown via that same flag, or a
  // user message already in `shown`) — typing without sending doesn't extend or shorten the wait any more.
  const topicWatch = active && !crisis && !!view?.clockStarted && !view.closed && !view.topicAsked
    && !shown.some((m) => m.role === "user") && topicWaitStart !== null;
  useEffect(() => {
    if (!topicWatch || !view || topicWaitStart === null) return;
    let typingShown = false;
    const id = setInterval(async () => {
      if (sending.current || nudging.current || revealing.current > 0) return;
      const elapsed = Date.now() - topicWaitStart;
      if (!typingShown && elapsed >= view.topicWaitTypingSeconds * 1000) { setTyping(true); typingShown = true; }
      if (elapsed < view.topicWaitSeconds * 1000) return;
      nudging.current = true;
      const typedSince = Date.now();
      try {
        const r = await post<SendResult>("/api/topic-prompt", { token });
        if (r.view) sync(r.view);
        if (r.ok && r.messages?.length) await reveal(r.messages, typedSince);
        else setTyping(false);
      } catch {
        setTyping(false);
      } finally {
        nudging.current = false;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [topicWatch, view, token, sync, reveal, topicWaitStart]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending.current || locked) return;
    sending.current = true;
    lastActivity.current = Date.now();
    draftRef.current = "";
    setDraft("");
    setSendError(false);
    setBusy(true);
    stickToBottom.current = true;
    setShown((prev) => [...prev, { role: "user", text, at: "" }]);
    try {
      // Any of the engage ladder's fixed turns (1-3) gets the same slower pre-typing silence as the rest of their
      // pacing — fully predictable from view.upcomingEngageTurn, unlike the answer-phase reveal, which depends on
      // what the model decides to do with this message. Turn 1's own extra-long pause (before its question bubble)
      // happens inside reveal() instead, since both its bubbles come back in this same reply.
      const upcoming = view?.upcomingEngageTurn ?? 0;
      const preDelay = upcoming >= 1 && upcoming <= 3 ? pacing.current.post_kundli_gap_ms : pacing.current.read_delay_ms;
      await sleep(preDelay); // a beat before "typing…", like a person reading
      setTyping(true);
      const typedSince = Date.now();
      const r = await post<SendResult>("/api/chat", { token, text });
      if (r.view) sync(r.view);
      if (r.ok) {
        if (r.messages?.length) await reveal(r.messages, typedSince, r.ladderTurn, r.chartLineIndex);
        else setTyping(false);
      } else {
        // Not accepted (e.g. time ran out): show exactly what the server has.
        setTyping(false);
        if (r.view?.messages) setShown(r.view.messages);
      }
    } catch {
      // Network failure: take the message back so the user can resend it.
      setTyping(false);
      setShown((prev) => prev.slice(0, -1));
      setDraft(text);
      draftRef.current = text;
      setSendError(true);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  // Local development only: wipe this chat and open it fresh.
  const restart = async () => {
    await post<View>("/api/session", { token, restart: true });
    window.location.reload();
  };

  if (loadError) {
    return (
      <Shell>
        <Empty title="Slow network" text="Please open the link again in a moment." />
      </Shell>
    );
  }
  if (!view) return <Shell><Skeleton /></Shell>;

  if (view.status === "choose_language") {
    // A known user (real details already on file) whose language just isn't known yet — Omkar greets them the
    // same way as a brand-new user, but only ever asks for the language: picking one starts the chat immediately
    // with their existing name/kundli, on this same link, no name/DOB form needed.
    return (
      <Shell>
        <header className={s.header}>
          <div className={s.avatarWrap}>
            <Avatar persona={view.persona} className={s.avatar} />
            <span className={s.onlineDot} aria-hidden />
          </div>
          <div className={s.who}>
            <div className={s.name}>
              {view.persona.name}
              {view.persona.verified ? <VerifiedIcon /> : null}
            </div>
            <div className={`${s.label} ${s.labelOnline}`}>Online</div>
          </div>
        </header>
        <div className={s.list}>
          <div className={s.dayChip}>Today</div>
          <div className={s.systemNote}>Connecting you to {view.persona.name}…</div>
          <div className={s.systemNote}>{view.persona.name} has joined</div>
          <div className={s.aiRow}>
            <Avatar persona={view.persona} className={s.miniAvatar} />
            <div className={`${s.bubble} ${s.ai} ${s.tailAi}`}>Namaste 🙏</div>
          </div>
          <div className={s.aiRow}>
            <Avatar persona={view.persona} className={s.miniAvatar} />
            <div className={`${s.bubble} ${s.ai} ${s.tailAi}`}>{view.languagePrompt}</div>
          </div>
          <div className={s.onboardLangTabs}>
            {view.languageOptions.map((opt) => (
              <button
                key={opt.key} type="button" className={s.onboardLangTab} disabled={pickingLang}
                onClick={() => void pickLanguage(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  if (view.status === "invalid") {
    // Omkar's own first message, before he knows anything about this person: a greeting, then he asks for
    // language + details himself — the form is the reply to his own message, not a separate page or dialog.
    return (
      <Shell>
        <header className={s.header}>
          <div className={s.avatarWrap}>
            <Avatar persona={view.persona} className={s.avatar} />
            <span className={s.onlineDot} aria-hidden />
          </div>
          <div className={s.who}>
            <div className={s.name}>
              {view.persona.name}
              {view.persona.verified ? <VerifiedIcon /> : null}
            </div>
            <div className={`${s.label} ${s.labelOnline}`}>Online</div>
          </div>
        </header>
        <div className={s.list}>
          <div className={s.dayChip}>Today</div>
          <div className={s.systemNote}>Connecting you to {view.persona.name}…</div>
          <div className={s.systemNote}>{view.persona.name} has joined</div>
          <Onboard
            onDone={(tok) => router.push(`/c/${tok}`)}
            persona={view.persona}
            languageOptions={view.languageOptions} languagePrompt={view.languagePrompt}
            onboardingLabels={view.onboardingLabels}
          />
        </div>
      </Shell>
    );
  }

  const ui = view.ui;
  // Once the hand-off card is up the chat is over (no more input), so the header says so too: one clock, not two.
  const over = timeUp || showSheet;
  const timeFrac = over ? 0 : Math.min(1, Math.max(0, msLeft / (view.freeSeconds * 1000)));
  // The button counts down ctaCountdown seconds from the moment the card appears, then stays as "Talk to astrologer →".
  const ctaMs = (view.ctaCountdown ?? 5) * 1000;
  const ctaLeftMs = cardAt && ctaMs > 0 ? Math.min(ctaMs, Math.max(0, ctaMs - (now - cardAt))) : 0;
  const ringFrac = ctaMs > 0 ? ctaLeftMs / ctaMs : 0;
  const ctaSeconds = Math.ceil(ctaLeftMs / 1000);

  return (
    <Shell>
      <header className={s.header}>
        <button
          type="button"
          className={s.back}
          aria-label="Back"
          onClick={() => {
            // Back if there's somewhere to go; inside WhatsApp (first page) open the app instead of doing nothing.
            if (window.history.length > 1) window.history.back();
            else {
              beacon(token, "back_to_app", { seconds_left: left }); // leaving, not a CTA decision: counted separately
              if (/^https?:\/\//i.test(view.handoffUrl) || !view.fallbackUrl) window.location.href = view.handoffUrl;
              else openApp(null, view.handoffUrl, view.fallbackUrl);
            }
          }}
        >
          <BackIcon />
        </button>
        <div className={s.avatarWrap}>
          <Avatar persona={view.persona} className={s.avatar} />
          {!over && !crisis ? <span className={s.onlineDot} aria-hidden /> : null}
        </div>
        <div className={s.who}>
          <div className={s.name}>
            {view.persona.name}
            {view.persona.verified ? <VerifiedIcon /> : null}
          </div>
          <div className={`${s.label} ${typing && !over ? s.labelTyping : ""} ${!over && !typing ? s.labelOnline : ""}`}>
            {over ? ui.time_up_status : typing ? ui.status_typing : [view.persona.label, ui.status_online].filter(Boolean).join(" · ")}
          </div>
        </div>
        {crisis ? null : <div className={`${s.timer} ${urgent && !over ? s.timerUrgent : ""} ${over ? s.timerDone : ""}`} aria-live="off">
          {over ? (
            <span>{ui.time_up}</span>
          ) : (
            <>
              <ClockIcon />
              <span className={s.timerNum}>{fmt(left)}</span>
              <span className={s.timerFree}>free</span>
            </>
          )}
        </div>}
        {crisis ? null : (
          <div className={s.timeTrack} aria-hidden>
            <div className={`${s.timeBar} ${urgent && !over ? s.timeBarUrgent : ""}`} style={{ transform: `scaleX(${timeFrac})` }} />
          </div>
        )}
      </header>

      {crisis ? null : (
        <div className={`${s.strip} ${showSheet ? s.stripWin : ""}`} key={showSheet ? "win" : "gift"}>
          <span className={s.stripIcon} aria-hidden>{showSheet ? "🎉" : "🎁"}</span>
          <span className={s.stripText}>{showSheet ? ui.strip_reveal.replace(/^🎉\s*/, "") : ui.strip_during.replace(/^🎁\s*/, "")}</span>
          {showSheet ? (
            <a className={s.stripCta} href={view.handoffUrl} onClick={(e) => { beacon(token, "cta_tapped", { seconds_left: left, from: "strip" }); openApp(e, view.handoffUrl, view.fallbackUrl); }}>
              {ui.strip_cta}
            </a>
          ) : null}
        </div>
      )}

      <div
        className={`${s.list} ${showSheet ? s.listUnderSheet : ""}`}
        ref={listRef}
        aria-live="polite"
        onTouchMove={() => { userScrollAt.current = Date.now(); }}
        onWheel={() => { userScrollAt.current = Date.now(); }}
        onScroll={(e) => {
          // Only the user's own scrolling decides whether we follow new messages.
          if (Date.now() - userScrollAt.current > 800) return;
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={s.dayChip}>{ui.day_chip}</div>
        {shown.map((m, i) => {
          const next = shown[i + 1];
          const lastOfGroup = !next || next.role !== m.role;
          if (m.role === "details") return <DetailsCard key={i} text={m.text} />;
          if (m.role === "system") return <div key={i} className={s.systemNote}>{m.text}</div>;
          if (m.role === "kundli") {
            return (
              <KundliCard
                key={i}
                title={m.text}
                subtitle={view.chart?.kundli?.basis === "moon" ? ui.kundli_moon_chart : ui.kundli_lagna_chart}
                kundli={view.chart?.kundli ?? null}
                facts={view.chart ? [
                  { label: ui.moon_sign_label, value: view.chart.moonSign },
                  { label: ui.dasha_label, value: [view.chart.mahadasha, view.chart.antardasha].filter(Boolean).join(" · ") },
                ].filter((f) => f.value) : []}
              />
            );
          }
          if (m.role === "user") return <div key={i} className={`${s.bubble} ${s.user} ${lastOfGroup ? s.tailUser : ""}`}>{m.text}</div>;
          return (
            <div key={i} className={s.aiRow}>
              <Avatar
                persona={view.persona}
                className={s.miniAvatar}
                style={{ visibility: lastOfGroup && !(typing && !next) ? "visible" : "hidden" }}
              />
              <div className={`${s.bubble} ${s.ai} ${lastOfGroup ? s.tailAi : ""}`}>{m.text}</div>
            </div>
          );
        })}
        {typing ? (
          <div className={s.aiRow}>
            <Avatar persona={view.persona} className={s.miniAvatar} />
            <div className={`${s.bubble} ${s.ai} ${s.tailAi} ${s.typing}`} aria-label={`${view.persona.name} likh rahe hain`}>
              <i /><i /><i />
            </div>
          </div>
        ) : null}
      </div>

      <Confetti fire={cardVisible && left > 0} />  {/* the live reveal only, not when reopening an ended chat */}
      {showSheet && cardVisible ? (
        <section className={s.sheet} aria-label={ui.cta_label}>
          <div className={s.handle} aria-hidden />
          <div className={s.sheetHead}>
            <Avatar persona={view.persona} className={s.sheetAvatar} />
            <div>
              <p className={s.sheetText}>{ui.card_text}</p>
              <span className={s.offer}>🎁 {ui.card_offer}</span>
            </div>
          </div>
          <a
            className={`${s.cta} ${ctaSeconds > 0 ? s.ctaUrgent : s.ctaDone}`}
            href={view.handoffUrl}
            onClick={(e) => { beacon(token, "cta_tapped", { seconds_left: left, from: "sheet" }); openApp(e, view.handoffUrl, view.fallbackUrl); }}
          >
            <span className={s.ctaLabel}>{ui.cta_label}</span>
            {ctaSeconds > 0 ? <CountdownRing frac={ringFrac} seconds={ctaSeconds} /> : <ArrowIcon />}
          </a>
          <p className={s.sheetSub}><VerifiedIcon className={s.sheetSubTick} />{ui.cta_subtext}</p>
          {view.canRestart && timeUp ? (
            <button type="button" className={s.restart} onClick={() => void restart()}>Restart chat (local testing only)</button>
          ) : null}
        </section>
      ) : !locked ? (
        <form className={s.composer} onSubmit={(e) => { e.preventDefault(); void send(); inputRef.current?.focus(); }}>
          {sendError ? <p className={s.sendError} role="alert">{ui.send_error}</p> : null}
          <label htmlFor="message" className={s.srOnly}>{ui.input_placeholder}</label>
          <input
            id="message"
            ref={inputRef}
            className={s.input}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              draftRef.current = e.target.value;
              lastActivity.current = Date.now(); // typing counts as not quiet
              if (sendError) setSendError(false);
            }}
            placeholder={ui.input_placeholder}
            maxLength={500}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button className={s.send} type="submit" disabled={busy || !draft.trim()} aria-label="Send">
            <SendIcon />
          </button>
        </form>
      ) : (
        <div className={s.endedBar}>
          {ui.ended_title}
          {view.canRestart ? (
            <button type="button" className={s.restart} onClick={() => void restart()}>Restart chat (local testing only)</button>
          ) : null}
        </div>
      )}
    </Shell>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return <main className={s.shell}>{children}</main>;
}

// The persona's photo (persona.avatar_url in config), or their initial if there is none or it fails to load.
function Avatar({ persona, className, style }: { persona: View["persona"]; className: string; style?: React.CSSProperties }) {
  const [failed, setFailed] = useState(false);
  const initial = persona.name.trim().slice(0, 1).toUpperCase();
  return (
    <div className={className} style={style} aria-hidden>
      {persona.avatar && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny avatar, may be a remote URL from config
        <img src={persona.avatar} alt="" className={s.avatarImg} onError={() => setFailed(true)} draggable={false} />
      ) : (
        initial
      )}
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon} aria-hidden>✨</div>
      <h1 className={s.emptyTitle}>{title}</h1>
      <p className={s.emptyText}>{text}</p>
    </div>
  );
}

const MONTHS_OPT: [string, string][] = [
  ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"], ["05", "May"], ["06", "June"],
  ["07", "July"], ["08", "August"], ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"],
];
const MONTH_VALUES = MONTHS_OPT.map(([v]) => v);
const monthLabel = (v: string) => MONTHS_OPT.find(([mv]) => mv === v)?.[1] ?? v;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // last day of month m (1-indexed)

// A short, roller-style picker: ~5 options visible at once, scroll/snap to pick, like an iOS wheel — instead of
// a native <select> whose dropdown can be a very long list (60 minutes, 100+ years) to scroll through at once.
const WHEEL_ITEM_H = 36;
const WHEEL_VISIBLE = 5;
const WHEEL_PAD = WHEEL_ITEM_H * Math.floor(WHEEL_VISIBLE / 2);

function WheelPicker({
  options, value, onChange, ariaLabel, labelFor, disabled, onConfirm,
}: {
  options: string[]; value: string; onChange: (v: string) => void; ariaLabel: string;
  labelFor?: (v: string) => string; disabled?: boolean; onConfirm?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);
  // The bold/centred item, tracked live off the actual scroll position — not the committed `value`, which only
  // updates once scrolling settles. Keeps the highlight moving with your finger instead of snapping in afterwards.
  const [liveIdx, setLiveIdx] = useState(() => options.indexOf(value));

  // Keeps the wheel scrolled to match `value` whenever it changes from outside (a tap, or clamping from
  // another wheel) — options is a stable array per field, so this only re-runs on a real value/length change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = options.indexOf(value);
    if (idx < 0) return;
    const target = idx * WHEEL_ITEM_H;
    // Scrolling (even programmatically) fires scroll events as it animates, which is what keeps liveIdx
    // caught up — no separate setState needed here.
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTo({ top: target, behavior: "smooth" });
  }, [value, options]);

  const indexFromScroll = () => {
    const el = ref.current;
    if (!el) return -1;
    return Math.max(0, Math.min(options.length - 1, Math.round(el.scrollTop / WHEEL_ITEM_H)));
  };

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const idx = indexFromScroll();
    const picked = options[idx];
    el.scrollTo({ top: idx * WHEEL_ITEM_H, behavior: "smooth" });
    if (picked !== undefined && picked !== value) onChange(picked);
  };

  return (
    <div className={`${s.wheel} ${disabled ? s.wheelDisabled : ""}`} role="listbox" aria-label={ariaLabel} aria-disabled={disabled}>
      <div className={s.wheelWindow} aria-hidden />
      <div
        ref={ref}
        className={s.wheelScroll}
        style={{ height: WHEEL_ITEM_H * WHEEL_VISIBLE, paddingTop: WHEEL_PAD, paddingBottom: WHEEL_PAD }}
        onScroll={() => {
          if (disabled) return;
          // Live highlight: recomputed every frame while scrolling, not debounced.
          if (raf.current) cancelAnimationFrame(raf.current);
          raf.current = requestAnimationFrame(() => setLiveIdx(indexFromScroll()));
          // The actual committed value: only once scrolling has settled.
          if (settleTimer.current) clearTimeout(settleTimer.current);
          settleTimer.current = setTimeout(commit, 120);
        }}
      >
        {options.map((o, i) => (
          <div
            key={o}
            className={`${s.wheelItem} ${i === liveIdx ? s.wheelItemActive : ""}`}
            style={{ height: WHEEL_ITEM_H, lineHeight: `${WHEEL_ITEM_H}px` }}
            onClick={() => { if (disabled) return; if (i === liveIdx) onConfirm?.(); else { onChange(o); setLiveIdx(i); } }}
            role="option"
            aria-selected={i === liveIdx}
          >
            {labelFor ? labelFor(o) : o}
          </div>
        ))}
      </div>
    </div>
  );
}

// One compact field for the whole date of birth — tapping it opens Day/Month/Year together, side by side, in
// the exact same spot the field sat. No confirm button and no backdrop — tapping outside (the existing
// document listener) is enough to close it, same as any other dropdown.
function DobField({
  day, month, year, days, years, onDay, onMonth, onYear,
}: {
  day: string; month: string; year: string; days: string[]; years: string[];
  onDay: (v: string) => void; onMonth: (v: string) => void; onYear: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const display = day && month && year ? `${day} ${monthLabel(month)} ${year}` : "";

  return (
    <div className={s.wheelFieldWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${s.onboardInput} ${s.wheelFieldBtn}`}
        style={open ? { visibility: "hidden" } : undefined}
        onClick={() => setOpen(true)}
        aria-label="Date of birth"
      >
        <span className={display ? undefined : s.wheelFieldPlaceholder}>{display || "Date of birth"}</span>
      </button>
      {open ? (
        <div className={s.wheelOverlay}>
          <div className={s.dobRow}>
            <WheelPicker options={days} value={day} onChange={onDay} ariaLabel="Day" />
            <WheelPicker options={MONTH_VALUES} value={month} labelFor={monthLabel} onChange={onMonth} ariaLabel="Month" />
            <WheelPicker options={years} value={year} onChange={onYear} ariaLabel="Year" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// English default copy for the onboarding form — what Hinglish (and any language with no override) shows.
// Structural bits (Day/Month/Year/Hour/Min/AM-PM, month names, the city field itself) are never translated.
const DEFAULT_ONBOARD_LABELS = {
  title: "Please fill in your details so that I can build your kundli.",
  name_label: "Name",
  dob_label: "Date of birth",
  submit_label: "Start my free chat",
  submit_busy: "Please wait…",
  error_missing: "Please fill in your birth date.",
  error_failed: "Something didn't work. Please check your details and try again.",
};

// Phase 5: self-serve onboarding, for a /u/<user_id> Redash never sent us. Two sequential steps, both as real
// Omkar chat bubbles, not a page or dialog: (1) a greeting, then he asks which language — the reply is just the
// language roller; (2) once picked, a second message (now in that language) asks for the details, with the
// name/DOB card appearing below it. Builds a real chart from what they type: just name and DOB — gender, time
// of birth and place of birth don't change anything astrologically meaningful enough to ask for here (no lagna
// is possible without a time of birth either way; see chart.ts).
function Onboard({
  onDone, persona, languageOptions, languagePrompt, onboardingLabels,
}: {
  onDone: (token: string) => void; persona: { name: string; label: string; avatar: string; verified: boolean };
  languageOptions: { key: string; label: string }[]; languagePrompt: string;
  onboardingLabels: Record<string, Partial<typeof DEFAULT_ONBOARD_LABELS>>;
}) {
  const [language, setLanguage] = useState("");
  const labels = { ...DEFAULT_ONBOARD_LABELS, ...(language ? onboardingLabels[language] ?? {} : {}) };
  const [name, setName] = useState("");
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const dob = day && month && year ? `${year}-${month}-${day}` : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const years = useMemo(() => {
    const thisYear = new Date().getFullYear();
    return Array.from({ length: thisYear - 1920 + 1 }, (_, i) => String(thisYear - i));
  }, []);
  const dayCount = month && year ? daysInMonth(Number(year), Number(month)) : 31;
  const days = useMemo(() => Array.from({ length: dayCount }, (_, i) => String(i + 1).padStart(2, "0")), [dayCount]);
  // Clamps the day right when month/year changes (e.g. 31 Feb isn't possible), rather than via an effect.
  const clampDay = (d: string, m: string, y: string) => {
    if (!d || !m || !y) return d;
    const max = daysInMonth(Number(y), Number(m));
    return Number(d) > max ? String(max).padStart(2, "0") : d;
  };

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!dob) {
      setError(labels.error_missing);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await post<{ ok: boolean; token?: string }>("/api/onboard", {
        name: name.trim(), dob, language,
      });
      if (r.ok && r.token) onDone(r.token);
      else setError(labels.error_failed);
    } catch {
      setError(labels.error_failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={s.aiRow}>
        <Avatar persona={persona} className={s.miniAvatar} />
        <div className={`${s.bubble} ${s.ai} ${s.tailAi}`}>Namaste 🙏</div>
      </div>
      <div className={s.aiRow}>
        <Avatar persona={persona} className={s.miniAvatar} />
        <div className={`${s.bubble} ${s.ai} ${s.tailAi}`}>{languagePrompt}</div>
      </div>
      {language ? (
        <div className={`${s.bubble} ${s.user} ${s.tailUser}`}>
          {languageOptions.find((o) => o.key === language)?.label ?? language}
        </div>
      ) : (
        <div className={s.onboardLangTabs}>
          {languageOptions.map((opt) => (
            <button key={opt.key} type="button" className={s.onboardLangTab} onClick={() => setLanguage(opt.key)}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {language ? (
        <>
          <div className={s.aiRow}>
            <Avatar persona={persona} className={s.miniAvatar} />
            <div className={`${s.bubble} ${s.ai} ${s.tailAi}`}>{labels.title}</div>
          </div>
          <form className={s.onboard} onSubmit={(e) => void submit(e)}>
            {error ? <p className={s.sendError} role="alert">{error}</p> : null}
            <label className={s.onboardLabel}>
              <span>{labels.name_label} <span className={s.onboardOptional}>(optional)</span></span>
              <input
                className={s.onboardInput} value={name} onChange={(e) => setName(e.target.value)}
                maxLength={80} autoComplete="name" autoCapitalize="words"
              />
            </label>
            <label className={s.onboardLabel}>
              {labels.dob_label}
              <DobField
                day={day} month={month} year={year} days={days} years={years}
                onDay={setDay}
                onMonth={(v) => { setMonth(v); setDay((d) => clampDay(d, v, year)); }}
                onYear={(v) => { setYear(v); setDay((d) => clampDay(d, month, v)); }}
              />
            </label>
            <button type="submit" className={`${s.cta} ${s.ctaDone}`} disabled={busy}>
              <span className={s.ctaLabel}>{busy ? labels.submit_busy : labels.submit_label}</span>
              {busy ? null : <ArrowIcon />}
            </button>
          </form>
        </>
      ) : null}
    </>
  );
}

function Skeleton() {
  return (
    <div className={s.skeleton} aria-label="Loading" role="status">
      <div className={s.skHeader} />
      <div className={s.skBody}>
        <div className={`${s.sk} ${s.skRight}`} />
        <div className={`${s.sk} ${s.skCard}`} />
        <div className={s.sk} />
        <div className={`${s.sk} ${s.skShort}`} />
      </div>
    </div>
  );
}

// "Meri details:\nName · Gender · DOB\nTime · Place" → a tidy card on the user's side.
function DetailsCard({ text }: { text: string }) {
  const [title, ...lines] = text.split("\n");
  return (
    <div className={`${s.detailsCard} ${s.appear}`}>
      <div className={s.detailsTitle}>{title.replace(/:$/, "")}</div>
      {lines.map((l, i) => <div key={i} className={s.detailsLine}>{l}</div>)}
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function VerifiedIcon({ className = s.verified }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Verified">
      <path fill="#22c55e" d="M12 1.5l2.6 1.9 3.2-.1 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.1L12 22.5l-2.6-1.9-3.2.1-1-3L2.6 15.8l1-3-1-3 2.6-1.9 1-3 3.2.1z" />
      <path d="M8 12.2l2.6 2.6L16.2 9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M3.4 20.4 21 12 3.4 3.6l.1 6.5L15 12l-11.5 1.9z" />
    </svg>
  );
}

// The seconds left, inside a ring that empties smoothly (100 ms ticks + a short CSS transition).
// The number pops on each new second, so the last seconds are felt without anything flashing.
function CountdownRing({ frac, seconds }: { frac: number; seconds: number }) {
  const R = 15, C = 2 * Math.PI * R;
  return (
    <span className={s.ring} aria-label={`${seconds} seconds left`}>
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden>
        <circle cx="19" cy="19" r={R} className={s.ringTrack} />
        <circle cx="19" cy="19" r={R} className={s.ringArc} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <span key={seconds} className={s.ringNum}>{seconds}</span>
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg className={s.ctaArrow} width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
