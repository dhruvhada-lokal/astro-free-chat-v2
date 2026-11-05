// npm run replay -- "msg 1" - "msg 2" … → plays a whole chat through the live prompt with real Gemini (first sample user),
// so a prompt change can be judged on a full conversation. "-" = the user stays quiet (Omkar carries on). Nothing is stored.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  load, buildContext, newSession, openingBubbles, chartIntro, chartLine, closingBubbles, runTurn, runNudge, bubblesFor,
} from "../src/engine/engine.ts";
import type { UserInput } from "../src/engine/engine.ts";
import { callModel, isMock } from "../src/lib/llm.ts";

const L = load();
if (isMock()) { console.error("GEMINI_API_KEY is not set (add it to .env.local)."); process.exit(1); }
const [user] = parse(readFileSync("samples/users.yaml", "utf8")) as UserInput[];
const ctx = buildContext(L.cfg, { ...user, last_topic: null });
const st = newSession(ctx);
const history: { role: "user" | "ai"; text: string }[] = openingBubbles(L.cfg, ctx).map((text) => ({ role: "ai", text }));
console.log(`${L.cfg.experiment.prompt_version} · ${user.name}\n` + history.map((m) => `   A: ${m.text}`).join("\n"));
let left = L.cfg.timing.free_seconds - 6;
for (const text of process.argv.slice(2)) {
  if (left <= 0) break;
  const quiet = text === "-";
  if (quiet) left -= L.cfg.timing.idle_nudge_seconds;
  const first = !st.chartShown;
  const n = bubblesFor(L, st, "replay");
  const { bubbles, log } = quiet
    ? await runNudge(L, ctx, st, left, callModel, history, n)
    : await runTurn(L, ctx, st, text, left, callModel, history, n);
  console.log(quiet ? `   (quiet · ${left}s left)` : `U: ${text}   (${left}s left)`);
  const withChart = first && ["llm", "quiet"].includes(log.route);
  if (withChart) st.chartShown = true;
  for (const b of withChart ? [chartIntro(L.cfg, ctx), "[kundli]", chartLine(L.cfg, ctx, st.currentTopic), ...bubbles] : bubbles) console.log(`   A: ${b}`);
  if (log.flags.length) console.log(`   flags: ${log.flags.join(", ")}`);
  if (!quiet) history.push({ role: "user", text });
  history.push(...bubbles.map((b) => ({ role: "ai" as const, text: b })));
  if (st.closed) break;
  left -= 14; // a quick typer
  if (left <= L.cfg.timing.closing_at_seconds_left && !st.closed) { if (!st.hooked) console.log(`   (${left}s left) A: ${closingBubbles(L.cfg, ctx).join(" | ")}`); break; }
}
