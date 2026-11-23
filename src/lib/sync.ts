// Daily sync: today's retargeted users (from the Redash query) → chat-ready users with their kundli.
//
// Every row needs a user_id; a date of birth is normally there too, but a row missing one is still synced (v3) —
// with no chart yet, so the chat itself asks for it (see chat.ts's needs_dob status) instead of a dead end.
// Everything else (name, tob, pob, …) is optional and simply left out if missing.
// The kundli is computed here (Lahiri, Vimshottari) from the birth details:
//   - birth time known + place found at city level (or lat/lon given) → full Lagna chart
//   - otherwise → Moon chart (no lagna); and if without a birth time the rashi/dasha could differ that day, it isn't stated
// The link token comes from the query's token column (so the WATI link and our store always agree); if the query has
// no token column, one is made here from user_id + TOKEN_SECRET + the send day, and written to the WATI file.
// The user_id is stored with the user (for joining chats with purchases) but never shown on screen or put in a chat URL.

import { createHash } from "node:crypto";
import { computeChart } from "./chart.ts";
import { findPlace } from "./places.ts";
import type { Config, UserInput } from "../engine/engine.ts";

export type SourceConfig = {
  redash_query_id: number;
  columns: {
    user_id: string; dob: string; tob: string; pob: string; name: string; gender: string; cohort: string;
    token?: string; lat?: string; lon?: string; last_topic?: string; last_summary?: string; wallet_balance?: string; holdout?: string;
    chat_language?: string;              // if the query already knows it, chat_language is set straight away — no picker shown
  };
  cohort_map?: Record<string, string>;   // their journey name → our cohort (see config.cohorts)
  // the query's language word (e.g. "Hindi") → our config.languages key (e.g. "hinglish"); matched case-insensitively.
  // An unmapped or unrecognised value is simply left unset — the usual in-chat picker shows instead, never an error.
  language_map?: Record<string, string>;
  links?: { user_id_pattern?: string; require_signature?: boolean; lookback_days?: number; one_chat_every_days?: number };
  on_click?: { enabled?: boolean; cache_minutes?: number; list_ready_at?: string; wait_on_miss_seconds?: number };
  lagna_needs_city?: boolean;            // true: a place matched only to its state gets a Moon chart, not a guessed lagna
};

export type SyncRow = Record<string, unknown>;
export type Synced = { user_id: string; user: UserInput; journey: string; place: string };
export type SyncReport = {
  rows: number; synced: number; holdout: number;
  skipped: { line: number; why: string }[];
  charts: { lagna: number; moon: number; rashiUncertain: number; dashaUncertain: number }; // no birth time and it changes that day
  severalProfiles: number; // users with more than one kundli profile (the most complete one is used)
  noName: number;
  // v3: no longer skipped — synced with no chart; the chat asks them for it (see chat.ts's needs_dob status).
  noDob: number;
  places: { city: number; state: number; latlon: number; none: number };
  journeys: Record<string, number>; unmappedJourneys: string[];
};

// Column names match whatever their case (Redash keeps "DOB", a CSV export may give "dob").
const caseless = (row: SyncRow): SyncRow =>
  new Proxy(row, { get: (t, k) => (typeof k === "string" && !(k in t) ? t[Object.keys(t).find((x) => x.toLowerCase() === k.toLowerCase()) ?? k] : t[k as string]) });
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** The chat's internal id for one user on one send day. Never shown in the WATI link; the link carries the user_id. */
export function linkToken(secret: string, userId: string, day: string): string {
  return createHash("sha256").update(`${secret}:${userId}:${day}`).digest("hex").slice(0, 20);
}

/** Optional link signature (source.links.require_signature): the query can output it so a user_id can't be changed by hand. */
export function linkSignature(secret: string, userId: string): string {
  return createHash("sha256").update(`${secret}:sig:${userId}`).digest("hex").slice(0, 10);
}

/**
 * /u/<user_id> → the chat token of that user's latest send (today, else up to lookback_days back), or null.
 * null covers: bad user_id, missing/wrong signature when required, or not in a recent sync.
 */
export async function resolveUserLink(
  getUser: (token: string) => Promise<unknown>, secret: string, uid: string, sig: string | null,
  links: SourceConfig["links"] = {}, now = Date.now(), getSession?: (token: string) => Promise<unknown>,
): Promise<string | null> {
  if (!linkAllowed(secret, uid, sig, links)) return null;
  // One free chat per user every N days: if they opened a chat in that window, they get that same chat back
  // (ended after its 2 minutes, with the "Talk to astrologer" button), not a new one.
  const every = links.one_chat_every_days ?? 0;
  if (every > 0 && getSession) {
    for (let back = 0; back < every; back++) {
      const token = linkToken(secret, uid, istDay(back, now));
      if (await getSession(token)) return token;
    }
  }
  for (let back = 0; back <= (links.lookback_days ?? 2); back++) {
    const token = linkToken(secret, uid, istDay(back, now));
    if (await getUser(token)) return token;
  }
  return null;
}

/** The link's user_id looks right and, if signatures are required, carries the right one. */
export function linkAllowed(secret: string, uid: string, sig: string | null, links: SourceConfig["links"] = {}): boolean {
  if (!secret || !new RegExp(links.user_id_pattern ?? "^[0-9]{1,15}$").test(uid)) return false;
  return !links.require_signature || sig === linkSignature(secret, uid);
}

/** IST calendar day, n days back. */
export function istDay(daysBack = 0, now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000 - daysBack * 86_400_000).toISOString().slice(0, 10);
}

export function rowsToUsers(
  cfg: Config, src: SourceConfig, rows: SyncRow[], opts: { secret: string; day: string; now?: Date },
): { users: Synced[]; report: SyncReport } {
  const c = src.columns;
  const report: SyncReport = {
    rows: rows.length, synced: 0, holdout: 0, skipped: [], charts: { lagna: 0, moon: 0, rashiUncertain: 0, dashaUncertain: 0 },
    severalProfiles: 0, noName: 0, noDob: 0,
    places: { city: 0, state: 0, latlon: 0, none: 0 }, journeys: {}, unmappedJourneys: [],
  };
  const users: Synced[] = [];
  const seen = new Set<string>();
  // A user can have several saved kundli profiles (e.g. family members). Nothing tells us which is theirs, so the most
  // complete one is used (a valid date, then a birth time, then a place we can match); ties keep the first row.
  const score = (r: SyncRow) =>
    (normaliseDate(str(r[c.dob])) ? 4 : 0) + (normaliseTime(str(r[c.tob])) ? 2 : 0) + (findPlace(str(r[c.pob])) ? 1 : 0);
  const best = new Map<string, number>();
  const profiles = new Map<string, Set<string>>();
  rows.forEach((raw, i) => {
    const r = caseless(raw);
    const id = str(r[c.user_id]);
    if (!id) return;
    const prev = best.get(id);
    if (prev === undefined || score(r) > score(caseless(rows[prev]))) best.set(id, i);
    if (!profiles.has(id)) profiles.set(id, new Set());
    profiles.get(id)!.add(`${str(r[c.dob])}|${str(r[c.tob])}|${str(r[c.pob])}`);
  });
  report.severalProfiles = [...profiles.values()].filter((p) => p.size > 1).length;
  const unmapped = new Set<string>();

  rows.forEach((raw, i) => {
    const r = caseless(raw);
    const line = i + 1;
    const skip = (why: string) => report.skipped.push({ line, why });
    const userId = str(r[c.user_id]);
    if (!userId) return skip("no user_id");
    if (best.get(userId) !== i || seen.has(userId)) return; // another row of this user is the one used
    seen.add(userId);
    if (c.holdout && /^(1|true|yes|holdout)$/i.test(str(r[c.holdout]))) { report.holdout++; return; }

    const dob = normaliseDate(str(r[c.dob]));
    if (!dob) report.noDob++;
    const tob = normaliseTime(str(r[c.tob]));
    const name = str(r[c.name]); // optional: without it the chat greets "Namaste ji" and says "aap"
    if (!name) report.noName++;

    // Where they were born: exact coordinates if the query has them, else the place name.
    const pobText = str(r[c.pob]);
    const lat = c.lat ? Number(r[c.lat]) : NaN, lon = c.lon ? Number(r[c.lon]) : NaN;
    const hasLatLon = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    const found = hasLatLon ? null : findPlace(pobText);
    const coords = hasLatLon ? { lat, lon } : found ?? { lat: 23.0, lon: 80.0 }; // India's centre only for moon/dasha (lagna is dropped)
    const placeOk = hasLatLon || found?.precision === "city" || (found?.precision === "state" && src.lagna_needs_city === false);
    report.places[hasLatLon ? "latlon" : found ? found.precision : "none"]++;

    // No valid dob: synced anyway, with no chart yet — chat.ts's needs_dob screen asks them for it directly
    // (v3), carrying along whatever else the row did have (name/tob/pob/cohort) rather than dropping them.
    let chart: ReturnType<typeof computeChart> | null = null;
    let lagna: string | null = null;
    let moonCertain = true, dashaCertain = true;
    if (dob) {
      try {
        chart = computeChart({ dob, tob, lat: coords.lat, lon: coords.lon }, opts.now);
      } catch {
        return skip("could not compute the chart");
      }
      lagna = tob && placeOk ? chart.lagna : null;
      // Without a birth time, check whether the rashi / dasha could be different at another hour of that day.
      // If so, the chat never states it (and no kundli card is shown when the rashi itself is uncertain).
      if (!tob) {
        const early = computeChart({ dob, tob: "00:01", ...coords }, opts.now), late = computeChart({ dob, tob: "23:59", ...coords }, opts.now);
        moonCertain = early.moon_sign === late.moon_sign;
        dashaCertain = moonCertain && early.mahadasha === late.mahadasha && early.antardasha === late.antardasha;
        if (!moonCertain) report.charts.rashiUncertain++;
        else if (!dashaCertain) report.charts.dashaUncertain++;
      }
      report.charts[lagna ? "lagna" : "moon"]++;
    }

    const journey = str(r[c.cohort]);
    const mapped = src.cohort_map?.[journey] ?? (cfg.cohorts?.[journey] ? journey : null);
    if (journey && !mapped) unmapped.add(journey);
    report.journeys[journey || "(empty)"] = (report.journeys[journey || "(empty)"] ?? 0) + 1;

    // Known already → the in-chat language picker is skipped entirely (same effect as chooseLanguage()).
    // Case-insensitive, since the query gives a word ("Hindi"), not our internal key ("hinglish").
    const langRaw = c.chat_language ? str(r[c.chat_language]) : "";
    const mapEntry = langRaw && src.language_map
      ? Object.entries(src.language_map).find(([k]) => k.toLowerCase() === langRaw.toLowerCase())?.[1]
      : undefined;
    const chatLanguage = mapEntry ?? (langRaw && cfg.languages?.[langRaw.toLowerCase()] ? langRaw.toLowerCase() : null);

    const topic = c.last_topic ? str(r[c.last_topic]).toLowerCase() : "";
    const balance = c.wallet_balance ? Number(r[c.wallet_balance]) : NaN;
    const token = (c.token && str(r[c.token])) || linkToken(opts.secret, userId, opts.day);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) return skip("token column has an invalid value");

    users.push({
      user_id: userId,
      journey,
      place: hasLatLon ? "lat/lon" : found?.matched ?? "not found",
      user: {
        token,
        user_id: userId,
        name,
        gender: /^f/i.test(str(r[c.gender])) ? "female" : /^m/i.test(str(r[c.gender])) ? "male" : null,
        dob: dob ?? "", tob: tob || null, pob: pobText || null,
        language: "Hinglish",
        moon_sign: chart?.moon_sign ?? "", mahadasha: chart?.mahadasha ?? "", antardasha: chart?.antardasha ?? "", lagna,
        // Without a birth time the Moon's degree is uncertain, so it isn't drawn; slow planets are placed as usual.
        planets: !chart ? null : tob ? chart.planets : Object.fromEntries(Object.entries(chart.planets).filter(([k]) => k !== "Mo")),
        moon_certain: dob ? moonCertain : undefined,
        dasha_certain: dob ? dashaCertain : undefined,
        last_topic: topic && cfg.topics[topic] ? topic : null,
        last_summary: c.last_summary ? str(r[c.last_summary]) || null : null,
        cohort: mapped ?? cfg.default_cohort ?? null,
        chat_language: chatLanguage,
        wallet_balance: Number.isFinite(balance) ? balance : null,
      },
    });
  });

  report.synced = users.length;
  report.unmappedJourneys = [...unmapped];
  return { users, report };
}

/** YYYY-MM-DD from the usual formats (ISO, with a time part, DD-MM-YYYY, DD/MM/YYYY). */
export function normaliseDate(s: string): string | null {
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) { const d = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); if (d) m = ["", d[3], d[2].padStart(2, "0"), d[1].padStart(2, "0")] as RegExpMatchArray; }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso || t.getUTCFullYear() < 1920 || t > new Date() ? null : iso;
}

/** HH:MM (24h) from "15:40", "15:40:00", "3:40 PM"; "" if unknown. */
export function normaliseTime(s: string): string {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return "";
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) { const pm = m[3].toLowerCase() === "pm"; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || min > 59 || (h === 0 && min === 0 && !m[3])) return ""; // 00:00 is how many systems store "unknown"
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The query's most recent stored result (no re-run): fast, used when a link is clicked. */
export async function fetchRedashLatest(
  baseUrl: string, queryId: number, apiKey: string, fetchFn: typeof fetch = fetch,
): Promise<{ rows: SyncRow[]; retrievedAt: string }> {
  const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/api/queries/${queryId}/results.json`, {
    headers: { Authorization: `Key ${apiKey}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Redash answered ${r.status} for query ${queryId}`);
  const body = (await r.json()) as { query_result?: { retrieved_at: string; data: { rows: SyncRow[] } } };
  if (!body.query_result) throw new Error(`Redash has no stored result for query ${queryId} yet`);
  return { rows: body.query_result.data.rows, retrievedAt: body.query_result.retrieved_at };
}

/** Fetches fresh results of a Redash query (refreshes it, waits for the job, returns the rows). */
export async function fetchRedash(
  baseUrl: string, queryId: number, apiKey: string, fetchFn: typeof fetch = fetch, pollMs = 2000,
): Promise<SyncRow[]> {
  const headers = { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };
  const base = baseUrl.replace(/\/$/, "");
  const start = await fetchFn(`${base}/api/queries/${queryId}/results`, { method: "POST", headers, body: JSON.stringify({ max_age: 0 }) });
  if (!start.ok) throw new Error(`Redash refused the query (${start.status}). Check REDASH_API_KEY and the query id.`);
  let body = (await start.json()) as { job?: { id: string }; query_result?: { data: { rows: SyncRow[] } } };
  for (let i = 0; !body.query_result && body.job && i < 120; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const job = (await (await fetchFn(`${base}/api/jobs/${body.job.id}`, { headers })).json()) as {
      job: { id: string; status: number; error?: string; query_result_id?: number };
    };
    if (job.job.status === 4) throw new Error(`Redash query failed: ${job.job.error ?? "unknown error"}`);
    if (job.job.status === 3 && job.job.query_result_id) {
      body = (await (await fetchFn(`${base}/api/query_results/${job.job.query_result_id}.json`, { headers })).json()) as typeof body;
    } else body = { job: job.job };
  }
  if (!body.query_result) throw new Error("Redash query did not finish in 4 minutes.");
  return body.query_result.data.rows;
}
