// v3: a real targeted user (a real user_id) with no date of birth on file is let into the chat anyway — it
// asks them for it directly, right in the conversation (see chat.ts's needs_dob status / submitDob()).
// This fills in the ONE thing missing on their own existing record (same user_id, cohort and token); it never
// creates a separate account. tob/pob are never asked here — if the campaign row already had them despite no
// valid dob, they're kept and used; otherwise the chart is built the same "no birth time" way sync.ts always
// does (Moon chart, rashi/dasha only stated when they can't differ across the day).
import { computeChart } from "./chart.ts";
import { findPlace } from "./places.ts";
import type { UserInput } from "../engine/engine.ts";

export type DobInput = { name?: unknown; dob?: unknown };
export type DobResult = { ok: true; user: UserInput } | { ok: false; error: string };

const DOB_RX = /^\d{4}-\d{2}-\d{2}$/;

/** Builds the chart from the dob they just typed in, keeping everything else about their real account as is. */
export function applySubmittedDob(existing: UserInput, input: DobInput, now = new Date()): DobResult {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const dob = String(input.dob ?? "").trim();

  if (!DOB_RX.test(dob)) return { ok: false, error: "dob_invalid" };
  const dobDate = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(dobDate.getTime()) || dobDate > now || dobDate.getUTCFullYear() < 1920) return { ok: false, error: "dob_invalid" };

  const tob = existing.tob || null;
  const found = findPlace(existing.pob ?? "");
  const coords = found ?? { lat: 23.0, lon: 80.0 }; // India's centre only for moon/dasha math; no lagna without a real match
  const placeOk = found?.precision === "city";

  let chart;
  try {
    chart = computeChart({ dob, tob, lat: coords.lat, lon: coords.lon }, now);
  } catch {
    return { ok: false, error: "chart_failed" };
  }
  const lagna = tob && placeOk ? chart.lagna : null;

  let moonCertain = true, dashaCertain = true;
  if (!tob) {
    const early = computeChart({ dob, tob: "00:01", ...coords }, now);
    const late = computeChart({ dob, tob: "23:59", ...coords }, now);
    moonCertain = early.moon_sign === late.moon_sign;
    dashaCertain = moonCertain && early.mahadasha === late.mahadasha && early.antardasha === late.antardasha;
  }

  const user: UserInput = {
    ...existing,
    name: name || existing.name,
    dob,
    moon_sign: chart.moon_sign, mahadasha: chart.mahadasha, antardasha: chart.antardasha, lagna,
    planets: tob ? chart.planets : Object.fromEntries(Object.entries(chart.planets).filter(([k]) => k !== "Mo")),
    moon_certain: moonCertain, dasha_certain: dashaCertain,
    // This flow only ever asks for dob — if there's still no tob, the details card should say nothing about
    // it rather than "Birth time not known" (that phrasing is for a tob we actually asked for and didn't get).
    tob_asked: tob ? existing.tob_asked : false,
  };
  return { ok: true, user };
}
