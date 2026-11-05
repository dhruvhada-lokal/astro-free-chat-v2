# What changed before the prompt_template.md rewrite

This covers the work done in this session up through **free_chat_v2.6** — the last version where
`prompt_template.md` was still the original skeleton, before it was completely replaced.

## Feature work

- **Self-serve onboarding**: name made optional, a DOB roller for date of birth, gender/time of birth optional.
  A missing-detail chat never blocks (no name → "Namaste ji" + "aap"; no gender/place → left out; no birth
  time → rashi/dasha only stated when certain, no kundli card if the rashi isn't certain).
- **Multi-language support**: Tamil, Telugu, Malayalam added as full language overrides (guardrails union with
  the base language, never swap it out). The known-user "missing language" flow was converted to match the
  self-serve chat-bubble UI.
- **The conversational funnel**: greet → wait (7.5s typing / 10s send) → ask topic → gather context (one
  clarifying question, budget-limited) → chart-based finding → ongoing "engage" turns with a scheduled "doubt"
  hook every 3rd turn (`ENGAGE_DOUBT_EVERY`) → final "hook" stage (last ~40s, one open thread) → closing.
- **AI reply-quality tuning**: word-length caps (`guardReply`'s `max_words_per_bubble`), present-continuous
  tense requirement, hedged (non-decisive) language, topic-specific (not generic) follow-up questions, and a
  deliberate "don't fully resolve, create curiosity" sales-funnel psychology (the app's business goal is
  converting free-chat users into paid app users).

## Engine mechanisms introduced

- `CLARIFY_MARKER = "CLARIFY||"` convention: stage "gather" prefixes its one clarifying question with this so
  the engine can tell a clarifying question apart from a real finding without guessing from the text.
- Dual clarify budgets: `clarifyRounds` (gather's own clarifying-question budget) kept separate from
  `noTopicRounds` (the deterministic "no topic at all" re-ask) — so a bare "hi" doesn't eat into the budget
  meant for "they gave a topic, still need one more detail."
- `topicNamedByUser` flag: once a topic is named, a later reply that doesn't repeat the topic word is never
  mistaken for "nothing was said at all."
- `engageTurns` counter, incremented unconditionally (even on a failed/guard-rejected reply) so the doubt-rhythm
  cadence can't silently drift or never fire.
- `bubblesFor()`: picks bubble count per turn (`first_answer_bubbles` for the first reply, `max_bubbles` for
  early replies, then `later_bubbles` varied by a hash of token+turn).
- `ask_yes` / `ask_no` / `canAsk`: a mechanism letting "engage" occasionally end on a personal question
  (retired later, in v2.7).

## Bugs found and fixed in this phase

- `say()`'s separator-collapsing regex bug (glued "Amit· 15 Jun 1995" with no space).
- Kundli reveal pacing math — `kundli_gap_ms` split out from `kundli_ms` (silence before "typing…" vs. the
  "typing…" duration itself).
- `engageTurns` only incrementing on success → moved to an unconditional increment in `route()`/`runNudge()`.
- The deterministic `clarify_topic` route re-firing after a topic had already been named → fixed by the
  `topicNamedByUser` flag.
- "hi" consuming stage "gather"'s own clarify budget → fixed by splitting `clarifyRounds` from `noTopicRounds`.
- A generic, conversation-killing `fallback_reply` → replaced with doubt-hook phrasing instead of a dead end.

## Content versions in this phase (see docs/CHANGELOG.md for the full table)

v1.0 (first internal test) through v2.6 (chart line stops naming the rashi) — pacing tweaks, opening-offer
copy, CTA wording, the "answer the first question, then insights, then one open thread" structure, the
wrong-dasha guard, and the missing-data handling described above.
