# What changed after the prompt_template.md rewrite

The user pasted a full rewrite of `prompt_template.md` (new "findings, not the answer" framing, explicit FLOW
steps) and asked to replace the prompt and try it — that became **free_chat_v2.7**. Everything below is
`v2.7` → `v4.1`. Full detail for each is in `docs/CHANGELOG.md`; this groups them by what kind of change
they actually are, since that matters for deciding what a revert would undo.

## A. The prompt rewrite itself, and reconciling it

- **v2.7** — `prompt_template.md` replaced wholesale (GOAL/FLOW/HOW YOU TEXT/NEVER sections). Reconciled
  against existing flow work: `insight_levels`/`answer`/`gather` reworded "give the answer" → "give a finding";
  `ask_yes`/`ask_no`/`canAsk` retired (contradicted the new "no more questions" rule); `question_budget` 3 → 1.
- **v3.0–v3.3** — bubble 1 (the finding) and bubble 2 (the hook) redefined and repeatedly re-tuned for tone:
  strongly positive/consoling vs. too literary vs. too negative/complex (a real live sample read as a
  discouraging double-negative; rewritten as "acknowledge what they're going through, then ONE simple positive
  chart detail").
- **v3.1** — simpler vocabulary rules added (no "vichar"/"gehra asar"/"nirnay"), never naming the rashi
  anywhere (not just the scripted line).
- **v3.2** — the hook made topic-specific instead of generic ("Iske peeche ek baat aur chhupi hai" → tied to
  their actual situation, "dhyaan rakhna hoga" style).
- **v3.1/v3.4** — new "need more details" redirect behavior for when they push on the hook or an earlier hint —
  this behavior didn't exist before v2.7 at all. v3.4 extended it to handle a *repeated* push (varies the
  doubt instead of repeating the redirect line).
- **v3.0** — new `pacing.post_kundli_gap_ms`/`post_kundli_typing_ms`: the dasha line, finding and hook each get
  their own slow, uniform reveal instead of length-based timing.

## B. Bugs found that are independent of the specific prompt wording

These would be bugs under *any* prompt content — they're engine/state-machine or data issues, not tone:

- **v2.8** — `MAX_CLARIFY_ROUNDS` 2 → 1 (gather could ask a second clarifying question) and the gather
  fallback preferring the stale profile topic over the one just named this turn.
- **v2.9** — "bacche" (a common spelling of "children") missing from `topics.parivaar`'s keyword list; and the
  gather fallback could repeat a line already said earlier in the chat (now checks `previous`).
- **v3.5** — a code-level guard (`chartFactHit`'s `stacked_terms` check) added because the prompt alone wasn't
  foolproof against naming two planets/dashas in one bubble.
- **v3.6** — **critical**: a failed "answer"-stage call never set `st.answered`, so a repeatedly failing model
  call left the chat stuck forever re-attempting stage "answer," sending the exact same fallback line every
  turn. Also added `fallback_reply_alt` so a second failure doesn't repeat the first fallback line either.
- **v3.7** — the gather fallback reused `topic_hook` ("Naukri ke baare mein jaanna hai?", a yes/no topic
  confirmation) instead of a real follow-up; new `topic_followup` map gives it one.

## C. Latency / timeout / clock tuning (not prompt content at all)

- **v3.8** — `llm_timeout_ms` 6000 → 18000 (most real replies were being discarded and replaced with the
  fallback, since real latency commonly ran 10-17s).
- **v3.9** — `max_output_tokens` 500 → 200 (then reverted to 500 in v4.1 — benchmarking showed no latency
  effect either way).
- **v4.0** — `llm_timeout_ms` 18000 → 10000, after discovering the free-chat clock (`secondsLeft`) is pure
  wall-clock time with no awareness of server-side waits, so a long timeout could burn a huge share of the
  120s budget on failed calls alone.
- **v4.1** — **the actual fix**: `SessionState.llmWaitMs` tracks time spent waiting on model calls; `secondsLeft()`
  subtracts it, so slow/failed calls no longer drain the user's free time at all. This made it safe to put
  `llm_timeout_ms` back to 18000 and `max_output_tokens` back to 500.

## What this means for a revert

Reverting *all* of A+B+C to the pre-v2.7 state would also undo the bugs in **B** (including the critical
stuck-loop bug in v3.6) and the clock-drain fix in **C** (v4.1) — those aren't about prompt tone, they're
correctness fixes that would still be bugs under the old prompt too.
