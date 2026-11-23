import { headers } from "next/headers";
import { getStore } from "@/lib/store";
import type { Session } from "@/lib/store";
import type { TurnLog, UserInput } from "@/engine/engine";
import { config } from "@/lib/chat";
import { analyse } from "@/lib/analytics";
import type { Funnel } from "@/lib/analytics";
import s from "./admin.module.css";

export const dynamic = "force-dynamic";

type Params = { v?: string; c?: string; tests?: string };

// The pilot at a glance: the funnel, what people talk about, how each version/cohort does, and the chats themselves.
// Definitions live in src/lib/analytics.ts. Real users only unless "Include team tests" is ticked.
export default async function Admin({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filter = { version: params.v || undefined, cohort: params.c || undefined, includeTests: params.tests === "1" };
  const h = await headers();
  const base = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`;

  const store = getStore();
  const [sessions, turns, events, testUsers] = await Promise.all([
    store.recentSessions(50000), store.recentTurnLogs(200000), store.events(200000), store.testUsers(),
  ]);
  const r = analyse(config().cfg, sessions, turns, events, filter);
  const f = r.funnel;
  const byToken = new Map(sessions.map((x) => [x.token, x]));
  const inView = new Set(r.chats.map((c) => c.token));
  const transcripts = sessions.filter((x) => inView.has(x.token)).slice(0, 30);
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <main className={s.page}>
      <header className={s.top}>
        <div>
          <h1>AI free chat · pilot</h1>
          <p className={s.note}>{filter.includeTests ? "Real users + team tests" : "Real users only"} · {filter.version ?? "all versions"} · {filter.cohort ?? "all cohorts"}</p>
        </div>
        <a className={s.btn} href={`/admin/export.csv${query ? `?${query}` : ""}`}>Download CSV</a>
      </header>

      <form className={s.filters} method="get">
        <select name="v" defaultValue={params.v ?? ""} aria-label="Version">
          <option value="">All versions</option>
          {r.versions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select name="c" defaultValue={params.c ?? ""} aria-label="Cohort">
          <option value="">All cohorts</option>
          {r.cohorts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className={s.check}><input type="checkbox" name="tests" value="1" defaultChecked={filter.includeTests} /> Include team tests</label>
        <button type="submit" className={s.btn}>Apply</button>
      </form>

      <section className={s.tiles}>
        <Tile label="Opened" n={f.opened} sub="users who opened the chat" />
        <Tile label="Spoke" n={f.spoke} sub={`${pct(f.spoke, f.opened)} of opened`} />
        <Tile label="Stayed to the offer" n={f.stayed} sub={`${pct(f.stayed, f.opened)} of opened`} />
        <Tile label="Tapped the CTA" n={f.tapped} sub={`${pct(f.tapped, f.opened)} of opened · ${pct(f.tapped, f.stayed)} of stayed`} strong />
      </section>

      <FunnelBars f={f} />

      <div className={s.grid}>
        <section>
          <h2>What they talked about</h2>
          <Table
            head={["Topic", "Chats", "Tap rate"]}
            rows={r.topics.map((t) => [t.topic === "none" ? "didn't name a topic" : t.topic, `${t.chats} (${pct(t.chats, f.opened)})`, pct(t.tapped, t.chats)])}
            empty="No chats yet."
          />
        </section>
        <section>
          <h2>Chat health</h2>
          <Table
            head={["", ""]}
            rows={[
              ["Messages per chat (user)", r.health.avgMessages ?? "–"],
              ["Sitara spoke up on silence", pct1(r.health.silenceShare)],
              ["Left via back arrow", r.health.backArrow],
              ["Fallback replies", pct1(r.health.fallbackShare)],
              ["Reply time (model)", r.health.avgReplySec === null ? "–" : `${r.health.avgReplySec} s`],
              ["Distress → helpline", r.health.crisis],
            ]}
          />
        </section>
      </div>

      <h2>By version and cohort</h2>
      <Table
        head={["Version", "Cohort", "Opened", "Spoke", "Stayed", "Tapped", "Tap rate"]}
        rows={r.byGroup.map((g) => [
          <a key="v" href={`?v=${encodeURIComponent(g.version)}&c=${encodeURIComponent(g.cohort)}${filter.includeTests ? "&tests=1" : ""}`}>{g.version}</a>,
          g.cohort, ...cells(g.funnel),
        ])}
        empty="No chats yet."
      />

      <details className={s.section}>
        <summary>By day (IST)</summary>
        <Table head={["Day", "Opened", "Spoke", "Stayed", "Tapped", "Tap rate"]} rows={r.daily.map((d) => [d.day, ...cells(d.funnel)])} empty="No chats yet." />
      </details>

      <details className={s.section}>
        <summary>Chats ({r.chats.length}{r.chats.length > 30 ? ", latest 30 shown" : ""})</summary>
        {transcripts.map((x) => <Transcript key={x.token} s={x} turns={turns.filter((t) => t.session_token === x.token)} />)}
        {transcripts.length === 0 ? <p className={s.note}>No chats for this filter.</p> : null}
      </details>

      <details className={s.section} id="test-links">
        <summary>Team testing</summary>
        <p className={s.note}>Test chats (demo users from <code>npm run seed</code>). Reset one to start it fresh.</p>
        {testUsers.length ? (
          <>
            <form method="post" action="/admin/reset" className={s.resetAll}>
              <input type="hidden" name="token" value="all" />
              <button type="submit">Reset all test chats</button>
            </form>
            <Table
              head={["Tester", "Status", ""]}
              rows={recentFirst(testUsers, byToken).slice(0, 30).map((u) => [
                profile(u),
                status(byToken.get(u.token)),
                <span key="a" className={s.actions}>
                  <a href={`${base}/c/${u.token}`} target="_blank" rel="noreferrer">Open</a>
                  <form method="post" action="/admin/reset">
                    <input type="hidden" name="token" value={u.token} />
                    <button type="submit" className={s.btn}>Reset</button>
                  </form>
                </span>,
              ])}
            />
          </>
        ) : null}
      </details>

      <p className={s.foot}>
        Tapped = “Talk to astrologer” or “Claim” (the back arrow is not counted). Recharges happen in the app: join the CSV to them on token via out/pilot_map.csv and compare with the holdout.
      </p>
    </main>
  );
}

function Tile({ label, n, sub, strong }: { label: string; n: number; sub: string; strong?: boolean }) {
  return (
    <div className={`${s.tile} ${strong ? s.tileStrong : ""}`}>
      <span className={s.tileLabel}>{label}</span>
      <span className={s.tileNum}>{n}</span>
      <span className={s.tileSub}>{sub}</span>
    </div>
  );
}

function FunnelBars({ f }: { f: Funnel }) {
  const steps: [string, number][] = [["Opened", f.opened], ["Spoke", f.spoke], ["Stayed to the offer", f.stayed], ["Tapped the CTA", f.tapped]];
  return (
    <div className={s.funnel} aria-label="Funnel">
      {steps.map(([name, n]) => (
        <div key={name} className={s.funnelRow}>
          <span>{name}</span>
          <span className={s.funnelTrack}><span className={s.funnelBar} style={{ width: f.opened ? `${(n / f.opened) * 100}%` : "0%" }} /></span>
          <span className={s.funnelNum}>{n} <small>{pct(n, f.opened)}</small></span>
        </div>
      ))}
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty?: string }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        {head.some(Boolean) ? <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead> : null}
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
          {rows.length === 0 && empty ? <tr><td colSpan={head.length}>{empty}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

const cells = (f: Funnel) => [f.opened, f.spoke, f.stayed, f.tapped, <b key="rate">{pct(f.tapped, f.opened)}</b>];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const pct1 = (x: number) => `${Math.round(x * 100)}%`;

// Newest chats first; links nobody has opened yet go last.
function recentFirst(users: UserInput[], byToken: Map<string, Session>) {
  const at = (u: UserInput) => byToken.get(u.token)?.started_at ?? "";
  return [...users].sort((a, b) => at(b).localeCompare(at(a)));
}

function profile(u: UserInput) {
  return [u.name, u.pob, u.cohort ?? null, `${u.moon_sign} · ${u.mahadasha}`].filter(Boolean).join(" · ");
}

function status(x: Session | undefined) {
  if (!x) return <span className={s.muted}>Not opened</span>;
  const asked = x.messages.filter((m) => m.role === "user").length;
  if (x.cta_tapped_at) return <span className={s.good}>Tapped · {asked} messages</span>;
  if (x.state.crisis) return <span className={s.bad}>Distress route</span>;
  if (x.state.closed || x.handoff_shown_at) return <span>Ended · {asked} messages</span>;
  return <span className={s.warn}>In progress · {asked} messages</span>;
}

function Transcript({ s: x, turns }: { s: Session; turns: TurnLog[] }) {
  const flags = [...new Set(turns.flatMap((t) => t.flags))];
  return (
    <details className={s.chat}>
      <summary>
        {new Date(x.started_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} · {x.cohort ?? "–"} · {x.prompt_version} ·{" "}
        {x.messages.filter((m) => m.role === "user").length} messages
        {x.cta_tapped_at ? <span className={s.good}> · tapped</span> : null}
        {x.state.crisis ? <span className={s.bad}> · distress</span> : null}
        {flags.length ? <span className={s.warn}> · {flags.join(", ")}</span> : null}
      </summary>
      <div className={s.msgs}>
        {x.messages.map((m, i) => (
          <div key={i} className={m.role === "user" || m.role === "details" ? s.u : m.role === "ai" ? s.a : s.k}>
            {m.role === "kundli" ? "[kundli card]" : m.text}
          </div>
        ))}
      </div>
    </details>
  );
}
