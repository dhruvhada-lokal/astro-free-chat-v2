// On-click lookup: when a /u/<user_id> link has no chat yet, find the user in the Redash query's result, build their
// chat (kundli included) and save it, so the link works without waiting for the daily sync.
//
// - Reads the query's stored result (no re-run per click) and keeps it in memory for cache_minutes, so a burst of
//   WhatsApp clicks is one Redash call per pod, not one per click. Concurrent clicks share the same request.
// - The list changes every morning (the retargeting journeys run 8:00–8:30 IST), so a stored result from before
//   today's list_ready_at (IST) is stale: the query is re-run once in the background (about 30 s).
// - A user who isn't in a stale result waits for that re-run (up to wait_on_miss_seconds) and is looked up again,
//   so someone added to today's list still gets their chat instead of the "link isn't working" page.
// - Each day's list is saved in full (every user's chat ready, tagged with the list's day), once per list, so a link
//   from that day's message keeps working for lookback_days even after the next day's list has replaced it.
// - Only users in the query get a chat. Anyone else gets the friendly page.
import type { Loaded } from "../engine/engine.ts";
import type { Store } from "./store.ts";
import { fetchRedash, fetchRedashLatest, rowsToUsers, istDay, linkToken } from "./sync.ts";
import type { SyncRow } from "./sync.ts";

type Cache = { byUser: Map<string, SyncRow[]>; rows: SyncRow[]; retrievedAt: string; loadedAt: number };
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
let refreshing: Promise<Cache | null> | null = null;
let savedList = ""; // retrievedAt of the list this pod has already saved

export type LookupEnv = { redashUrl: string; apiKey: string; secret: string; fetchFn?: typeof fetch; now?: number; store?: Store };

/** The most recent moment the list was due to be ready (today at list_ready_at IST, or yesterday's if earlier). */
export function lastListReadyAt(listReadyAt: string, now = Date.now()): number {
  const [h, m] = listReadyAt.split(":").map(Number);
  const IST = 5.5 * 3_600_000;
  const istMidnight = Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
  const today = istMidnight + (h * 60 + m) * 60_000;
  return now >= today ? today : today - 86_400_000;
}

const readyAt = (L: Loaded) => L.cfg.source!.on_click?.list_ready_at ?? "08:30";
const isStale = (L: Loaded, retrievedAt: string, now: number) =>
  new Date(retrievedAt).getTime() < lastListReadyAt(readyAt(L), now);

/** The day a list belongs to: the day whose list_ready_at it follows (a 07:00 run is still the previous day's list). */
export function listDay(L: Loaded, retrievedAt: string): string {
  const t = new Date(retrievedAt).getTime();
  return istDay(0, lastListReadyAt(readyAt(L), t));
}

// Saves every user on this list (chat ready, tagged with the list's day). Idempotent; once per list per pod.
function saveList(L: Loaded, env: LookupEnv, list: Cache) {
  if (!env.store || savedList === list.retrievedAt) return;
  savedList = list.retrievedAt;
  const day = listDay(L, list.retrievedAt);
  const { users } = rowsToUsers(L.cfg, L.cfg.source!, list.rows, { secret: env.secret, day });
  env.store.upsertUsers(users.map((u) => u.user))
    .then(() => console.log(`saved ${users.length} users from the ${day} list`))
    .catch((err) => { savedList = ""; console.error(`saving the ${day} list failed: ${(err as Error).message}`); });
}

function index(L: Loaded, rows: SyncRow[], retrievedAt: string, now: number): Cache {
  const byUser = new Map<string, SyncRow[]>();
  const idCol = L.cfg.source!.columns.user_id;
  for (const r of rows) {
    const id = String(r[idCol] ?? r[idCol.toLowerCase()] ?? "").trim();
    if (!id) continue;
    if (!byUser.has(id)) byUser.set(id, []);
    byUser.get(id)!.push(r);
  }
  return { byUser, rows, retrievedAt, loadedAt: now };
}

async function rows(L: Loaded, env: LookupEnv): Promise<Cache> {
  const src = L.cfg.source!;
  const ttl = (src.on_click?.cache_minutes ?? 10) * 60_000;
  const now = env.now ?? Date.now();
  if (cache && now - cache.loadedAt < ttl) return cache;
  if (!loading) {
    loading = (async () => {
      const { rows, retrievedAt } = await fetchRedashLatest(env.redashUrl, src.redash_query_id, env.apiKey, env.fetchFn);
      cache = index(L, rows, retrievedAt, now);
      if (isStale(L, retrievedAt, now)) void refresh(L, env);
      else saveList(L, env, cache);
      return cache;
    })().finally(() => { loading = null; });
  }
  return loading;
}

/** Re-runs the query once (shared by every caller) and swaps the fresh result in. */
function refresh(L: Loaded, env: LookupEnv): Promise<Cache | null> {
  if (!refreshing) {
    console.log(`redash result is from before today's list (${L.cfg.source!.on_click?.list_ready_at ?? "08:30"} IST); re-running query ${L.cfg.source!.redash_query_id}`);
    refreshing = fetchRedash(env.redashUrl, L.cfg.source!.redash_query_id, env.apiKey, env.fetchFn, env.now ? 1 : 2000)
      .then((fresh) => {
        cache = index(L, fresh, new Date(env.now ?? Date.now()).toISOString(), env.now ?? Date.now());
        saveList(L, env, cache);
        return cache;
      })
      .catch((err) => { console.error(`redash re-run failed: ${(err as Error).message}`); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Builds and saves today's chat for this user from the query, and returns its token; null if they aren't in it. */
export async function lookupUser(L: Loaded, store: Store, uid: string, env: LookupEnv): Promise<string | null> {
  const src = L.cfg.source;
  if (!src || src.on_click?.enabled === false || !env.apiKey || !env.secret) return null;
  env = { ...env, store };
  let current = await rows(L, env);
  let mine = current.byUser.get(uid);
  // Not in a result from before today's list: wait for the re-run (bounded) and look again.
  if (!mine?.length && isStale(L, current.retrievedAt, env.now ?? Date.now())) {
    const waitMs = (src.on_click?.wait_on_miss_seconds ?? 45) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fresh = await Promise.race([refresh(L, env), new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); })]);
    clearTimeout(timer);
    if (fresh) { current = fresh; mine = current.byUser.get(uid); }
  }
  if (!mine?.length) return null;
  const day = listDay(L, current.retrievedAt); // the list's day, the same tag the saved list uses
  const { users } = rowsToUsers(L.cfg, src, mine, { secret: env.secret, day });
  const user = users[0]?.user;
  if (!user) return null; // e.g. holdout, or the chart genuinely failed to compute
  user.token = linkToken(env.secret, uid, day); // the same token the daily sync would make, so both paths agree
  await store.upsertUsers([user]);
  return user.token;
}

/** For tests. */
export function resetLookupCache() { cache = null; loading = null; refreshing = null; savedList = ""; }
