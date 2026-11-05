// Self-serve onboarding (Phase 5): for a /u/<user_id> that Redash never sent us — instead of a dead end,
// they enter their own birth details and get a real chat, built the same way the daily sync builds one.
// Kept in its own cohort (self_serve) so /admin never mixes them into the real pilot's funnel.
import { randomBytes } from "node:crypto";
import { computeChart } from "./chart.ts";
import { findPlace } from "./places.ts";
import type { UserInput } from "../engine/engine.ts";

export type OnboardInput = { name?: unknown; gender?: unknown; dob?: unknown; tob?: unknown; pob?: unknown; language?: unknown };
export type OnboardResult = { ok: true; user: UserInput } | { ok: false; error: string };

const DOB_RX = /^\d{4}-\d{2}-\d{2}$/;
const TOB_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Builds a chat-ready user from self-entered details — only dob is required. Name, gender, time of birth and
 *  place of birth are all optional — a missing name falls back the same way it already does for a real synced
 *  user with a blank name column (see engine.ts's say(), which drops "{name} ji" down to just "ji" and
 *  "{name}'s Kundli" down to "Your Kundli"). Without a time of birth, place doesn't change the chart at all
 *  (lagna already needs both a real tob and a precise place; moon sign/dasha never depend on place — see
 *  chart.ts), so the form itself no longer asks for it; this just keeps accepting it if some other caller does. */
export function buildSelfServeUser(input: OnboardInput, now = new Date()): OnboardResult {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const pob = String(input.pob ?? "").trim().slice(0, 120);
  const dob = String(input.dob ?? "").trim();
  const tob = String(input.tob ?? "").trim();
  const gender = String(input.gender ?? "").trim().toLowerCase();
  const language = String(input.language ?? "").trim().toLowerCase();

  if (!DOB_RX.test(dob)) return { ok: false, error: "dob_invalid" };
  const dobDate = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(dobDate.getTime()) || dobDate > now || dobDate.getUTCFullYear() < 1920) return { ok: false, error: "dob_invalid" };
  if (tob && !TOB_RX.test(tob)) return { ok: false, error: "tob_invalid" };

  const found = findPlace(pob);
  const coords = found ?? { lat: 23.0, lon: 80.0 }; // India's centre only for moon/dasha math; no lagna without a real match
  const placeOk = found?.precision === "city";

  let chart;
  try {
    chart = computeChart({ dob, tob: tob || null, lat: coords.lat, lon: coords.lon }, now);
  } catch {
    return { ok: false, error: "chart_failed" };
  }
  const lagna = tob && placeOk ? chart.lagna : null;

  // Without a birth time: check whether the rashi/dasha could differ at another hour of that day (same rule sync.ts uses).
  let moonCertain = true, dashaCertain = true;
  if (!tob) {
    const early = computeChart({ dob, tob: "00:01", lat: coords.lat, lon: coords.lon }, now);
    const late = computeChart({ dob, tob: "23:59", lat: coords.lat, lon: coords.lon }, now);
    moonCertain = early.moon_sign === late.moon_sign;
    dashaCertain = moonCertain && early.mahadasha === late.mahadasha && early.antardasha === late.antardasha;
  }

  const token = randomBytes(16).toString("hex"); // opaque, unguessable; no user_id/day to derive it from here
  const user: UserInput = {
    token, user_id: null, name,
    gender: /^f/.test(gender) ? "female" : /^m/.test(gender) ? "male" : null,
    dob, tob: tob || null, pob: pob || null,
    language: "Hinglish",
    moon_sign: chart.moon_sign, mahadasha: chart.mahadasha, antardasha: chart.antardasha, lagna,
    planets: tob ? chart.planets : Object.fromEntries(Object.entries(chart.planets).filter(([k]) => k !== "Mo")),
    moon_certain: moonCertain, dasha_certain: dashaCertain,
    // The onboarding form doesn't ask for a birth time at all (see Onboard in Chat.tsx) — this is what tells
    // the details card to say nothing about it instead of "Birth time not known".
    tob_asked: false,
    // The language is picked before this form even shows (see Chat.tsx); if it's somehow missing, this just
    // falls through to the normal picker the same way any other chat_language-less user does.
    cohort: "self_serve", chat_language: language || null,
  };
  return { ok: true, user };
}
