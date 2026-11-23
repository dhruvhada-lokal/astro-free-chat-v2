// Daily sync: today's retargeted users → the chat store, each with their kundli. Run once a day after the query
// refreshes (Devtron cron), before the WATI send.
//
//   npm run sync                         → pulls Redash query source.redash_query_id (needs REDASH_API_KEY)
//   npm run sync -- --file rows.json     → same, from a saved Redash export (JSON rows) or a CSV, e.g. to test
//   add --dry-run to see the report without saving anything
//   npm run sync -- --inspect            → the query's columns: how often each is filled and the value format
//                                          (digits → 9, letters → a; never the values themselves), plus journey counts
//
// Env: DATABASE_URL (production store), TOKEN_SECRET, REDASH_API_KEY, REDASH_URL (default https://analytics.getlokalapp.com),
//      CHAT_BASE_URL (for the links in the WATI file, e.g. https://chat.astrolokal.com)
// Writes (private, git-ignored): out/sync_<day>.csv = user_id, cohort, link (/u/<user_id>)  → a check list for the WATI send
//                                out/sync_<day>_report.txt
// Exits with an error if nothing was synced or more than 20% of rows were skipped, so the cron shows red.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { load } from "../src/engine/engine.ts";
import { getStore } from "../src/lib/store.ts";
import { rowsToUsers, fetchRedash, istDay, linkSignature } from "../src/lib/sync.ts";
import type { SyncRow } from "../src/lib/sync.ts";
import { parseCsv } from "./import-users.ts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const { cfg } = load();
  const src = cfg.source;
  if (!src) throw new Error("config.yaml has no `source:` section");
  const secret = process.env.TOKEN_SECRET ?? "";
  if (secret.length < 16) throw new Error("Set TOKEN_SECRET (16+ characters, never change it mid-pilot).");

  const file = arg("file");
  let rows: SyncRow[];
  if (file) {
    const text = readFileSync(file, "utf8");
    rows = file.endsWith(".json") ? (JSON.parse(text).query_result?.data?.rows ?? JSON.parse(text)) : parseCsv(text);
  } else {
    const key = process.env.REDASH_API_KEY;
    if (!key) throw new Error("Set REDASH_API_KEY (the query's API key from Redash → the query → ⋮ → Show API Key).");
    rows = await fetchRedash(process.env.REDASH_URL ?? "https://analytics.getlokalapp.com", src.redash_query_id, key);
  }

  if (process.argv.includes("--inspect")) return inspect(rows, src.columns.cohort);

  const day = istDay();
  const { users, report } = rowsToUsers(cfg, src, rows, { secret, day });
  const missing = (["name", "gender"] as const).filter((k) => src.columns[k] && rows.length && !(src.columns[k]! in rows[0]));
  const base = (process.env.CHAT_BASE_URL ?? "https://chat.astrolokal.com").replace(/\/$/, "");

  const lines = [
    `sync ${day} · query ${src.redash_query_id} · ${cfg.experiment.prompt_version}${dryRun ? " · DRY RUN (nothing saved)" : ""}`,
    `rows ${report.rows} · synced ${report.synced} · holdout ${report.holdout} · skipped ${report.skipped.length}`,
    `kundli: ${report.charts.lagna} lagna charts · ${report.charts.moon} moon charts · without a birth time: ${report.charts.rashiUncertain} rashi not certain (no card, not stated), ${report.charts.dashaUncertain} dasha not certain (not stated)`,
    `several kundli profiles: ${report.severalProfiles} users (the most complete one used) · no name: ${report.noName} ("Namaste ji") · no dob yet: ${report.noDob} (asked in-chat)`,
    `birth place: ${report.places.city} city · ${report.places.state} state only · ${report.places.latlon} lat/lon · ${report.places.none} not found`,
    `journeys: ${Object.entries(report.journeys).map(([j, n]) => `${j} ${n}`).join(" · ")}`,
    ...(missing.length ? [`⚠ the query has no column for: ${missing.map((k) => `${k} ("${src.columns[k]}")`).join(", ")}${missing.includes("name") ? " (the chat greets without a name)" : ""}`] : []),
    ...(report.unmappedJourneys.length ? [`⚠ journeys not in cohort_map (treated as ${cfg.default_cohort}): ${report.unmappedJourneys.join(", ")}`] : []),
    ...report.skipped.slice(0, 50).map((s) => `  skipped row ${s.line}: ${s.why}`),
    ...(report.skipped.length > 50 ? [`  …and ${report.skipped.length - 50} more`] : []),
  ];
  console.log(lines.join("\n"));

  if (!dryRun) {
    await getStore().upsertUsers(users.map((u) => u.user));
    // The report files are a convenience: the users are already saved, so a read-only disk is a warning, not a failure.
    try {
      mkdirSync("out", { recursive: true });
      const sign = src.links?.require_signature;
      const csv = [["user_id", "cohort", "link"], ...users.map((u) => [u.user_id, u.user.cohort ?? "", `${base}/u/${u.user_id}${sign ? `?s=${linkSignature(secret, u.user_id)}` : ""}`])];
      writeFileSync(`out/sync_${day}.csv`, csv.map((r) => r.join(",")).join("\n") + "\n");
      writeFileSync(`out/sync_${day}_report.txt`, lines.join("\n") + "\n");
    } catch (err) {
      console.warn(`note: report files not written (${(err as Error).message}); the users were saved.`);
    }
  }

  if (report.synced === 0) throw new Error("Nothing was synced.");
  if (report.skipped.length > report.rows * 0.2) throw new Error(`${report.skipped.length} of ${report.rows} rows were skipped (over 20%). Check the column names in config.source.columns.`);
}

// Shape of the data without any personal values: filled share and the most common formats per column.
function inspect(rows: SyncRow[], cohortColumn: string) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  console.log(`${rows.length} rows · columns: ${cols.join(", ")}\n`);
  for (const c of cols) {
    const vals = rows.map((r) => (r[c] === null || r[c] === undefined ? "" : String(r[c]).trim()));
    const filled = vals.filter(Boolean);
    const shapes = new Map<string, number>();
    for (const v of filled) {
      const shape = v.replace(/[0-9]/g, "9").replace(/[A-Za-z\u0900-\u097F]+/g, "a").slice(0, 30);
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    }
    const top = [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sh, n]) => `"${sh}" ${n}`).join(" · ");
    console.log(`${c.padEnd(24)} filled ${String(filled.length).padStart(6)} (${Math.round((filled.length / rows.length) * 100)}%) · distinct ${new Set(filled).size} · formats: ${top}`);
  }
  const jc = cols.includes(cohortColumn) ? cohortColumn : null;
  if (jc) {
    const counts = new Map<string, number>();
    for (const r of rows) { const v = String(r[jc] ?? "").trim() || "(empty)"; counts.set(v, (counts.get(v) ?? 0) + 1); }
    console.log(`\njourneys (${jc}): ${[...counts].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(" · ")}`);
  }
}

main().catch((err) => {
  console.error(`sync failed: ${(err as Error).message}`);
  process.exit(1);
});
